// Zero-dependency static file server for local development.
// Usage: node serve.js [port]
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const port = Number(process.argv[2]) || 5500;
const root = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

http.createServer((req, res) => {
  const urlPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(root, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(port, () => {
  console.log(`Serving ${root} at http://localhost:${port}`);
});
