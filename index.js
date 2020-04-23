require('dotenv').config()

const log = require('pino')()
const sqlite = require('sqlite3')
const github = require('@octokit/rest')
const got = require('got')
const revHash = require('rev-hash')
const parseLinks = require('parse-link-header')

const TABLE_NAME = 'package_jsons'

async function setup () {
  const db = new sqlite.Database('db.sqlite')
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (url TEXT, contents BLOB, hash TEXT)`)
  })

  const octokit = new github.Octokit({ auth: process.env.SWEEP_TOKEN })

  return { db, octokit }
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
  const links = parseLinks(headers.link)
  return parseInt(links.last.page, 10)
}

async function getSearchResults (api, page) {
  const res = await api.search.code({
    q: 'name+filename:package.json+language:JSON',
    per_page: 100,
    page
  })

  const { data, headers } = res
  const rateLimits = getRateLimits(headers)
  const lastPageNumber = getLastPageNumber(headers)

  return { data, rateLimits, lastPageNumber }
}

function savePackageJsonData (db, { url, content, hash }) {
  return new Promise((resolve, reject) => {
    db.run(`INSERT INTO ${TABLE_NAME} VALUES (?, ?, ?)`, [url, content, hash], (err, res) => {
      if (err) {
        return reject(err)
      }
      return resolve()
    })
  })
}

async function downloadPackageJson (url) {
  const rawUrl = url.replace(/https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\//, 'https://raw.githubusercontent.com/$1/$2/')
  const res = await got(rawUrl)
  return res.body
}

async function processSearchResults (db, items) {
  const work = items.map(async (item) => {
    const { html_url: url } = item
    const content = await downloadPackageJson(url)
    const hash = revHash(content)
    return savePackageJsonData(db, { url, content, hash })
  })

  return Promise.all(work)
}

function sleepUntil (timestamp, buffer = 2000) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), timestamp - Date.now() + buffer)
  })
}

async function main () {
  log.info('Setting up DB and API access')
  const { db, octokit } = await setup()

  const pageFromArgs = parseInt(process.argv[2], 10)
  let lastPage = Number.POSITIVE_INFINITY

  try {
    for (let page = pageFromArgs || 0; page < lastPage; page++) {
      const { data, rateLimits, lastPageNumber } = await getSearchResults(octokit, page)
      const lastCallTimestamp = Date.now()
      lastPage = lastPageNumber
      log.info(
        'Received %d results on page %d; last page is %d; requests remaining: %d',
        data.items.length, page, lastPage, rateLimits.requestsRemaining
      )

      const dbResults = await processSearchResults(db, data.items)
      log.info('Inserted %d URLs into DB', dbResults.inserted)

      if (dbResults.errored.length) {
        log.error(dbResults.errored, 'Encountered error(s) inserting some URLs into DB')
      }

      const timeSinceLastCall = Date.now() - lastCallTimestamp
      if (rateLimits.requestsRemaining < 1) {
        log.info('Requests used up; sleeping until %d', rateLimits.resetTimestamp)
        await sleepUntil(rateLimits.resetTimestamp)
      } else if (timeSinceLastCall < 2000) {
        const timeToSleep = 2000 - timeSinceLastCall
        log.info('Sleeping %d ms to avoid abuse detection', timeToSleep)
        await sleepUntil(Date.now() + timeToSleep, 0)
      }
    }
  } catch (e) {
    log.error(e)
  } finally {
    log.info('Done; cleaning up database connection')

    await cleanup(db)
  }
}

main()
