const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

function createRequest({ method = "GET", headers = {}, body } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.headers = headers;
  process.nextTick(() => {
    if (body != null) req.emit("data", Buffer.from(body));
    req.emit("end");
  });
  return req;
}

function createResponse() {
  return {
    statusCode: null,
    headers: null,
    body: Buffer.alloc(0),
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      this.body = chunk ? Buffer.from(chunk) : Buffer.alloc(0);
    },
  };
}

async function request(handler, { method = "GET", token, origin, body } = {}) {
  const headers = {};
  if (token) headers["x-tokentracker-local-auth"] = token;
  if (origin) headers.origin = origin;
  const req = createRequest({
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const res = createResponse();
  const handled = await handler(
    req,
    res,
    new URL("http://127.0.0.1/functions/tokentracker-provider-credentials"),
  );
  return {
    handled,
    status: res.statusCode,
    text: res.body.toString("utf8"),
    body: JSON.parse(res.body.toString("utf8")),
  };
}

async function localAuthToken(handler) {
  const req = createRequest();
  const res = createResponse();
  const handled = await handler(req, res, new URL("http://127.0.0.1/api/local-auth"));
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  return JSON.parse(res.body.toString("utf8")).token;
}

test("provider credential API protects secrets and invalidates usage-limit cache", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-provider-credentials-api-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const usageLimits = require("../src/lib/usage-limits");
  const originalReset = usageLimits.resetUsageLimitsCache;
  let resetCalls = 0;

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  usageLimits.resetUsageLimitsCache = () => {
    resetCalls += 1;
  };
  delete require.cache[require.resolve("../src/lib/local-api")];
  const { createLocalApiHandler } = require("../src/lib/local-api");
  const handler = createLocalApiHandler({ queuePath: path.join(home, "queue.jsonl") });

  try {
    const token = await localAuthToken(handler);

    const unauthorizedRead = await request(handler);
    assert.equal(unauthorizedRead.handled, true);
    assert.equal(unauthorizedRead.status, 401);

    const unauthorizedWrite = await request(handler, {
      method: "POST",
      body: { provider: "deepseek", credentials: { api_key: "must-not-save" } },
    });
    assert.equal(unauthorizedWrite.status, 401);

    const foreignOrigin = await request(handler, {
      token,
      origin: "https://evil.example",
    });
    assert.equal(foreignOrigin.status, 401);

    const saved = await request(handler, {
      method: "POST",
      token,
      origin: "http://127.0.0.1:7680",
      body: {
        provider: "deepseek",
        credentials: { api_key: "sk-api-secret-1234" },
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.providers.deepseek.configured, true);
    assert.equal(saved.body.providers.deepseek.api_key_hint, "sk-••••1234");
    assert.doesNotMatch(saved.text, /sk-api-secret-1234/);
    assert.equal(resetCalls, 1);

    const read = await request(handler, {
      token,
      origin: "http://localhost:7680",
    });
    assert.equal(read.status, 200);
    assert.doesNotMatch(read.text, /sk-api-secret-1234/);

    const unsupported = await request(handler, {
      method: "POST",
      token,
      origin: "http://localhost:7680",
      body: { provider: "cc-switch", credentials: { api_key: "nope" } },
    });
    assert.equal(unsupported.status, 400);
    assert.match(unsupported.body.error, /Unknown provider/);
    assert.equal(resetCalls, 1);

    const removed = await request(handler, {
      method: "DELETE",
      token,
      origin: "http://localhost:7680",
      body: { provider: "deepseek" },
    });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.providers.deepseek.configured, false);
    assert.equal(resetCalls, 2);
    assert.equal(
      fs.existsSync(path.join(home, ".tokentracker", "tracker", "provider-credentials.json")),
      false,
    );
  } finally {
    usageLimits.resetUsageLimitsCache = originalReset;
    delete require.cache[require.resolve("../src/lib/local-api")];
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
