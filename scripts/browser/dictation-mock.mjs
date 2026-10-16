import http from "http";
let oaMode = "ok"; let file = "# test\nFejsa => façade\nsealant\nbacker rod\n"; let sha = "s1"; const log = [];
http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const body = Buffer.concat(chunks); const send = (s, j) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(j)); };
    log.push(`${req.method} ${req.url} ${body.length}`);
    if (req.url.startsWith("/__mode/")) { oaMode = req.url.split("/")[2]; return send(200, { oaMode }); }
    if (req.url === "/__log") return send(200, { log, file });
    if (req.url.startsWith("/repos/") && req.method === "GET") return send(200, { sha, content: Buffer.from(file).toString("base64") });
    if (req.url.startsWith("/repos/") && req.method === "PUT") { const j = JSON.parse(body.toString()); file = Buffer.from(j.content, "base64").toString(); sha = "s" + Date.now(); return send(200, {}); }
    if (req.url === "/v1/audio/transcriptions") {
      if (oaMode === "fail") return send(500, {});
      const s = body.toString("latin1"); const ok = s.includes('name="keywords[]"') && s.includes("sealant") && /filename="dictation\.(webm|m4a|ogg)"/.test(s);
      return setTimeout(() => send(200, { text: ok ? "Sealant has failed at the façade joint." : "BAD REQUEST SHAPE" }), 1200);
    }
    send(404, {});
  });
}).listen(5999, () => console.log("mock up"));
