require('dotenv').config()

const log = require('pino')({ base: null })
const crypto = require('crypto')
const sqlite = require('sqlite3')
const github = require('@octokit/rest')
const got = require('got')
const HttpAgent = require('agentkeepalive')
const parseLinks = require('parse-link-header')

const { HttpsAgent } = HttpAgent
const TABLE_NAME = 'package_jsons'

async function setup () {
  const db = new sqlite.Database('db.sqlite')
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      url text NOT NULL,
      data blob NOT NULL,
      hash text NOT NULL,
      git_hash text NOT NULL
    );`)
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_git_hash_pkg_jsons ON ${TABLE_NAME} (git_hash)`)
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_hash_pkg_jsons ON ${TABLE_NAME} (hash)`)
  })

  const octokit = new github.Octokit({
    auth: process.env.SWEEP_TOKEN,
    agent: new HttpsAgent()
  })

  const client = got.extend({
    agent: {
      http: new HttpAgent(),
      https: new HttpsAgent()
    }
  })
  return { db, octokit, client }
}

async function cleanup (db) {
  db.close()
}

function getRateLimits (headers) {
  const resetTimestamp = parseInt(headers['x-ratelimit-reset'] || '0', 10) * 1000
  const requestsRemaining = parseInt(headers['x-ratelimit-remaining'] || '0', 10)
  return { resetTimestamp, requestsRemaining }
}

function getLastPageNumber (headers) {
  if (!headers.link) return 0
  const links = parseLinks(headers.link)
  if (!links.last) return 0
  return parseInt(links.last.page, 10)
}

function * getHelpfulParams () {
  const sortParams = ['indexed', undefined]
  const orderParams = ['asc', 'desc']
  const searchTerms = [ // https://docs.npmjs.com/files/package.json
    'name',
    'version',
    'description',
    'keywords',
    'homepage',
    'bugs',
    'license',
    'author',
    'contributors',
    'files',
    'main',
    'browser',
    'bin',
    'man',
    'directories',
    'repository',
    'scripts',
    'config',
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'bundledDependencies',
    'optionalDependencies',
    'engines',
    'engineStrict',
    'os',
    'cpu',
    'preferGlobal',
    'private',
    'publishConfig'
  ]

  for (const sortParam of sortParams) {
    for (const orderParam of orderParams) {
      for (const searchTerm of searchTerms) {
        yield { sortParam, orderParam, searchTerm }
      }
    }
  }
}

async function getSearchResults (api, page, params) {
  const { sortParam, orderParam, searchTerm } = params
  const res = await api.search.code({
    q: `${searchTerm} filename:package.json+language:JSON`,
    per_page: 100,
    page,
    sort: sortParam,
    order: orderParam
  })

  const { data, headers } = res
  const rateLimits = getRateLimits(headers)
  const lastPageNumber = getLastPageNumber(headers)

  return { data, rateLimits, lastPageNumber }
}

function getHash (data) {
  return crypto.createHash('md5').update(data).digest('hex')
}

function savePackageJsonData (db, { url, content, hash, githash }) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO ${TABLE_NAME} VALUES (?, ?, ?, ?)`, [url, content, hash, githash], (err, res) => {
      if (err) {
        return reject(err)
      }
      return resolve(res)
    })
  })
}

async function downloadPackageJson (client, url) {
  const rawUrl = url.replace(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/$2/')
  const res = await client(rawUrl)
  log.info('Downloaded %d byte package json from %s', res.body.length, rawUrl)
  return res.body
}

async function haveSeenGitHash (db, githash) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT git_hash FROM ${TABLE_NAME} WHERE git_hash = ?`, [githash], (err, row) => {
      if (err) {
        return reject(err)
      }
      return resolve(!!row)
    })
  })
}

async function processSearchResults (db, client, items) {
  const work = items.map(async (item) => {
    const { html_url: url, sha: githash } = item
    if (await haveSeenGitHash(db, githash)) {
      log.info('Have already seen git hash %s, skipping download/save', githash)
      return 0
    }

    const content = await downloadPackageJson(client, url)
    const hash = getHash(content)
    try {
      await savePackageJsonData(db, { url, content, hash, githash })
      return 1
    } catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT') {
        log.warn('Have already saved content with hash %s, skipping save', hash)
        return 0
      } else {
        throw e
      }
    }
  })

  return (await Promise.all(work)).reduce((sum, res) => sum + res, 0)
}

function sleepUntil (timestamp, buffer = 2000) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), timestamp - Date.now() + buffer)
  })
}

function sleepFor (ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms)
  })
}

async function main () {
  log.info('Setting up DB and API access')
  const { db, octokit, client } = await setup()

  try {
    for (const params of getHelpfulParams()) {
      let lastPage = Number.POSITIVE_INFINITY
      for (let page = 0; page < lastPage; page++) {
        let res
        try {
          res = await getSearchResults(octokit, page, params)
        } catch (e) {
          if (e.status === 403 && e.headers && e.headers['retry-after']) {
          // abuse detection mechanism triggered :(
            await sleepFor(parseInt(e.headers['retry-after'], 10) * 1000)
            page--
            continue
          }
        }
        const { data, rateLimits, lastPageNumber } = res
        const lastCallTimestamp = Date.now()
        lastPage = lastPageNumber
        log.info(
          'Received %d results on page %d; last page is %d; requests remaining: %d',
          data.items.length, page, lastPage, rateLimits.requestsRemaining
        )

        const insertedCount = await processSearchResults(db, client, data.items)
        log.info('Inserted %d URLs into DB', insertedCount)

        const timeSinceLastCall = Date.now() - lastCallTimestamp
        if (rateLimits.requestsRemaining < 1) {
          log.info('Requests used up; sleeping until %d', rateLimits.resetTimestamp)
          await sleepUntil(rateLimits.resetTimestamp)
        } else if (timeSinceLastCall < 3000) {
          const timeToSleep = 3000 - timeSinceLastCall
          log.info('Sleeping %d ms to avoid abuse detection', timeToSleep)
          await sleepFor(timeToSleep)
        }
      }
    }
  } catch (e) {
    log.error(e)
  } finally {
    log.info('Closing database connection')

    await cleanup(db)
  }
}

main()
