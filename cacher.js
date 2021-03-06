const fetch = require("node-fetch")
const { dirname } = require("path")
const { ensureDirSync, ensureDir, existsSync, exists, renameSync, rename, removeSync, unlink, readFileSync, readFile, writeFileSync, writeFile } = require("fs-extra")
const { promisify } = require("util")

const move = promisify(rename), read = promisify(readFile), remove = promisify(unlink)

let config = {}
if(existsSync("./config.json"))
    config = JSON.parse(readFileSync("./config.json"))

const CACHE_LOCATION = "./cache/cached.json"

ensureDirSync("./cache/")
if(existsSync(CACHE_LOCATION + ".bak")) {
    if(existsSync(CACHE_LOCATION))
        removeSync(CACHE_LOCATION)
    renameSync(CACHE_LOCATION + ".bak", CACHE_LOCATION)
}

if(!existsSync(CACHE_LOCATION))
    writeFileSync(CACHE_LOCATION, "{}")
const cached = JSON.parse(readFileSync(CACHE_LOCATION))

let invalidatedMainVersion = false

let saveCachedTimeout = undefined, saveCachedCount = 0
const currentlyLoadingCache = {}

const cache = async (cacheFile, file, url, version, lastmodified, headers = {}) => {
    if(currentlyLoadingCache[file])
        return await new Promise((resolve) => currentlyLoadingCache[file].push(resolve))

    currentlyLoadingCache[file] = []
    console.log("Loading...", file)

    const response = (rep) => {
        currentlyLoadingCache[file].forEach(k => k(rep))
        delete currentlyLoadingCache[file]
        return rep
    }

    const options = { method: "GET", headers }

    // Request to only send full file if it has changed since last request
    if(lastmodified)
        options.headers["If-Modified-Since"] = lastmodified
    else
        delete options.headers["If-Modified-Since"]


    // Fetch data
    let data
    try {
        data = await fetch(url, options)
    } catch (error) {
        // Server denied request/network failed,
        if(lastmodified) {
            console.error("Fetch failed, using cached version", error)
            invalidatedMainVersion = true

            return response({
                "status": 200,
                "contents": await readFile(cacheFile)
            })
        } else {
            console.error("Fetch failed, no cached version", error)
            return response({
                "status": 502,
                "contents": "The caching proxy was unable to handle your request and no cached version was available"
            })
        }
    }

    if(data.status == 304) {
        if(!lastmodified)
            // Not modified, but we don't have cached data to update
            return response({ "status": data.status })

        // If not modified, update version tag and send cached data
        console.log("Not modified", file)

        cached[file].version = version
        queueCacheSave()

        return response({
            "status": 200,
            "contents": await readFile(cacheFile)
        })
    }

    // Send cached data for forbidden requests.
    // This bypasses the foreign ip block added on 2020-02-25
    if(data.status == 403 && lastmodified) {
        console.log("HTTP 403: Forbidden, using cached data")
        // Invalidate main.js and version.json versions since they might be outdated
        invalidatedMainVersion = true

        return response({
            "status": 200,
            "contents": await readFile(cacheFile)
        })
    }

    // These won't have useful responses
    if(data.status >= 400) {
        console.log("HTTP error ", data.status, url)
        return response(data)
    }

    // Store contents and meta-data
    const contents = await data.buffer()
    const rep = {
        "status": data.status,
        "contents": contents
    }

    const queueSave = async () => {
        await ensureDir(dirname(cacheFile))

        if(await exists(cacheFile + ".tmp"))
            await remove(cacheFile + ".tmp")
        await writeFile(cacheFile + ".tmp", contents)
        if(await exists(cacheFile))
            await remove(cacheFile)
        await move(cacheFile + ".tmp", cacheFile)

        cached[file] = {
            "version": version,
            "lastmodified": data.headers.get("last-modified"),
            "length": (+data.headers.get("content-length")) || contents.length,
            "cache": data.headers.get("cache-control")
        }
        queueCacheSave()

        console.log("Saved", url)
        response(rep)
    }
    if(cached[file])
        cached[file].length = (+data.headers.get("content-length")) || contents.length
    queueSave()

    return rep
}

const send = async (req, res, cacheFile, contents, file, cachedFile, forceCache = false) => {
    if (res) {
        if(contents == undefined)
            contents = await read(cacheFile)

        if(!forceCache && config.verifyCache && cachedFile && cachedFile.length && contents.length != cachedFile.length) {
            console.error(cacheFile, "length doesn't match!", contents.length, cachedFile.length)
            return handleCaching(req, res, true)
        }

        if(file && isBlacklisted(file)) {
            res.setHeader("Server", "nginx")
            if(!cachedFile || cachedFile.cache == "no-cache" || cachedFile.cache == "no-store")
                res.setHeader("Cache-Control", "no-store")
            else
                res.setHeader("Cache-Control", "max-age=2592000, public, immutable")
        } else {
            // Copy KC server headers
            res.setHeader("Server", "nginx")
            res.setHeader("X-DNS-Prefetch-Control", "off")

            if(config.disableBrowserCache || isInvalidated(file)) {
                res.setHeader("Cache-Control", "no-store")
                res.setHeader("Pragma", "no-cache")
            } else {
                res.setHeader("Cache-Control", "max-age=2592000, public, immutable")
                res.setHeader("Pragma", "public")
            }
        }

        // TODO switch or some table
        if (cacheFile.endsWith(".php") || cacheFile.endsWith(".html"))
            res.setHeader("Content-Type", "text/html")
        else if(cacheFile.endsWith(".png"))
            res.setHeader("Content-Type", "image/png")
        else if(cacheFile.endsWith(".json"))
            res.setHeader("Content-Type", "application/json")
        else if(cacheFile.endsWith(".css"))
            res.setHeader("Content-Type", "text/css")
        else if(cacheFile.endsWith(".mp3"))
            res.setHeader("Content-Type", "audio/mpeg")
        else if(cacheFile.endsWith(".js"))
            res.setHeader("Content-Type", "application/x-javascript")

        res.end(contents)
    }
}

const handleCaching = async (req, res, forceCache = false) => {
    const { url, headers } = req
    const { file, cacheFile, version } = extractURL(url)

    // Return cached if version matches
    const cachedFile = cached[file]
    let lastmodified = undefined
    if(cachedFile && await exists(cacheFile) && !forceCache) {
        // Allowing single ? for bugged _onInfoLoadComplete
        if((cachedFile.version == version || version == "" || version == "?") && !isBlacklisted(file) && !isInvalidated(file))
            return await send(req, res, cacheFile, undefined, file, cachedFile, forceCache)

        // Version doesn't match, lastmodified set
        lastmodified = cachedFile.lastmodified
    }

    // Not in cache or version mismatch, need to check with server
    const result = await cache(cacheFile, file, url, version, lastmodified, headers)

    if(!result.contents) {
        if(!res) return

        res.statusCode = result.status
        return res.end()
    }

    if(result.status >= 500 && result.contents) {
        if(!res) return

        res.statusCode = result.status
        return res.end(result.contents)
    }

    return await send(req, res, cacheFile, result.contents, file, cached[file], forceCache)
}

const extractURL = (url) => {
    let version = ""
    let file = "/" + url.match(/^https?:\/\/\d+\.\d+\.\d+\.\d+\/(.*)$/)[1]
    if (url.includes("?")) {
        version = url.substring(url.indexOf("?"))
        file = file.substring(0, file.indexOf("?"))
    }
    if(file.endsWith("/")) file += "index.html"
    const cacheFile = "./cache/" + file
    return { file, cacheFile, version }
}

const blacklisted = ["/gadget_html5/", "/kcscontents/information/index.html", "/kcscontents/news/"]
function isBlacklisted(file) {
    return blacklisted.some(k => file.startsWith(k))
}

const invalidated = ["/kcs2/version.json", "/kcs2/js/main.js"]
function isInvalidated(file) {
    return invalidatedMainVersion && invalidated.some(k => file == k)
}

function queueCacheSave() {
    if (++saveCachedCount < 25) {
        if (saveCachedTimeout)
            clearTimeout(saveCachedTimeout)
        saveCachedTimeout = setTimeout(async () => {
            saveCachedTimeout = undefined
            saveCachedCount = 0
            await saveCached()
            saveCachedCount = 0
        }, 5000)
    }
}

async function saveCached() {
    await move(CACHE_LOCATION, CACHE_LOCATION + ".bak")
    await writeFile(CACHE_LOCATION, JSON.stringify(cached))
    await remove(CACHE_LOCATION + ".bak")
    console.log("Saved cache.")
}

module.exports = { cache, handleCaching , extractURL, cached, queueCacheSave}
