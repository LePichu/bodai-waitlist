import { type Env, Hono } from "https://esm.sh/hono@4.10.4"
import { serveStatic } from "https://esm.sh/hono@4.10.4/deno"
import { rateLimiter } from "https://esm.sh/hono-rate-limiter?deps=hono@4.10.4"
import { load } from "https://deno.land/std@0.224.0/dotenv/mod.ts"

await load({ export: true })
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD")
const IS_DEPLOY = !!Deno.env.get("DENO_DEPLOYMENT_ID")

if (!ADMIN_PASSWORD) {
	console.warn(
		"WARN: ADMIN_PASSWORD is not set. Admin endpoint will be insecure.",
	)
	console.warn('Please create a .env file with ADMIN_PASSWORD="your_secret"')
}

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const app = new Hono<Env>()
const kv = await Deno.openKv()

const limiter = rateLimiter({
	windowMs: 10 * 60 * 1000,
	limit: 5,
	message: { error: "Too many requests, please try again later." },
	keyGenerator: (c) =>
		c.req.header("x-forwarded-for") || c.req.header("cf-connecting-ip") ||
		"unknown-ip",
})

let cachedHtmlContent: string | null = null

if (IS_DEPLOY) {
	try {
		cachedHtmlContent = await Deno.readTextFile("./index.html")
		console.log("index.html cached for Deno Deploy environment.")
	} catch (err) {
		console.error(
			"FATAL: Could not read index.html on Deploy startup.",
			err,
		)
		cachedHtmlContent =
			"<html><body><h1>Server Error</h1><p>Could not load page content.</p></body></html>"
	}
}

app.get("*", serveStatic({ root: "./public" }))

app.get("/", async (c) => {
	if (IS_DEPLOY && cachedHtmlContent) {
		return c.html(cachedHtmlContent)
	}

	try {
		const htmlContent = await Deno.readTextFile("./index.html")
		return c.html(htmlContent)
	} catch (err) {
		console.error("Error reading index.html:", err)
		return c.text("Internal Server Error", 500)
	}
})

app.post("/waitlist", limiter, async (c) => {
	try {
		const body = await c.req.json()
		const email = body.email

		if (!email || typeof email !== "string" || !emailRegex.test(email)) {
			return c.json({ error: "A valid email is required." }, 400)
		}

		const normalizedEmail = email.toLowerCase()
		const key = ["waitlist", normalizedEmail]

		const existing = await kv.get(key)
		if (existing.value !== null) {
			return c.json({ message: "You are already on the waitlist!" }, 200)
		}

		const waitlistEntry = {
			email: normalizedEmail,
			joinedAt: new Date().toISOString(),
		}
		await kv.set(key, waitlistEntry)

		console.log(`Added to waitlist: ${normalizedEmail}`)
		return c.json(
			{ message: "Success! You have been added to the waitlist." },
			201,
		)
	} catch (err) {
		console.error("Error in /waitlist POST:", err)
		return c.json({ error: "Internal server error." }, 500)
	}
})

app.get("/waitlist", async (c) => {
	const authHeader = c.req.header("x-alere-internal-auth")
	if (!ADMIN_PASSWORD || authHeader !== ADMIN_PASSWORD) {
		return c.json({ error: "Forbidden" }, 403)
	}

	const waitlist = []
	const entries = kv.list({ prefix: ["waitlist"] })

	for await (const entry of entries) {
		waitlist.push(entry.value)
	}
	const formattedJson = JSON.stringify(waitlist, null, 2)

	c.header("Content-Type", "application/json; charset=UTF-8")
	return c.body(formattedJson)
})

Deno.serve(app.fetch)

console.log(`Server running on http://localhost:8000 (Deploy: ${IS_DEPLOY})`)
