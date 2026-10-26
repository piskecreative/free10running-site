// Mirrors the published Framer site into ./site as a fully static, self-hosted copy.
// Usage: node mirror.mjs            (re-run any time after you publish changes in Framer)
import fs from "node:fs/promises";
import path from "node:path";

const ORIGIN = "https://free10running.framer.media";
const PAGES = ["/", "/event", "/gallery", "/about", "/qa"];
const OUT = path.resolve("site");
// Your own domain (no trailing slash). Also written to site/CNAME for GitHub Pages.
const SITE_URL = process.env.SITE_URL || "https://free10running.com";
const ASSET_HOSTS = ["framerusercontent.com", "fonts.gstatic.com", "app.framerstatic.com"];
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

const hostRe = ASSET_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|");
// Matches absolute asset URLs, plain or JSON-escaped (https:\/\/...)
const urlRe = new RegExp(`https?:(?:\\\\?/){2}(?:${hostRe})(?:\\\\?/[^"'\\s)<>\`\\\\?#,]*)+`, "g");
const relImportRe = /(["'`])(\.\.?\/(?![./]*node_modules)[A-Za-z0-9_\-./]+\.(?:mjs|js|json))\1/g;

const queue = new Map(); // remote url (no query) -> local path
const done = new Set();
const failed = [];

function localPathFor(remote) {
  const u = new URL(remote);
  // "/assets/" has the same length as "https://", so links inside binary files can be swapped in place.
  return path.join("assets", u.hostname, decodeURIComponent(u.pathname));
}
function webPath(local) {
  return "/" + local.split(path.sep).join("/");
}
function enqueue(remote) {
  const clean = remote.replace(/\\\//g, "/").split(/[?#]/)[0];
  if (clean.endsWith("/")) return clean; // URL prefix used by the runtime, not a file
  if (!queue.has(clean)) queue.set(clean, localPathFor(clean));
  return clean;
}
// Framer CMS data (.framercms) is binary with byte offsets: rewrite asset links in place, same length.
function rewriteBinary(buf) {
  const s = buf.toString("latin1");
  const out = s.replace(urlRe, (m) => {
    enqueue(m);
    return m.replace(/^https:\/\//, "/assets/");
  });
  if (out.length !== s.length) throw new Error("binary rewrite changed length");
  return Buffer.from(out, "latin1");
}
function isText(p) {
  return /\.(mjs|js|json|css|svg|html|txt)$/i.test(p);
}

// Rewrite every absolute asset URL in text to a root-relative local path, enqueueing as we go.
function rewrite(text, baseRemote) {
  text = text.replace(urlRe, (m) => {
    const escaped = m.includes("\\/");
    const clean = enqueue(m);
    let local = webPath(queue.get(clean) ?? localPathFor(clean)) + (clean.endsWith("/") ? "/" : "");
    return escaped ? local.replace(/\//g, "\\/") : local;
  });
  if (baseRemote) {
    for (const [, , rel] of text.matchAll(relImportRe)) enqueue(new URL(rel, baseRemote).href);
  }
  return text;
}

// Framer-runtime patches so the JS works on a plain static host.
const patchCounts = { cmsBase: 0, cmsRange: 0, editorBar: 0 };
function patchJs(text) {
  // CMS data files: `new URL("./x.framercms", "<module url>").href.replace("/modules/", "/cms/")`.
  // Download the /cms/ file and give `new URL` an absolute (current-origin) base.
  text = text.replace(
    /new URL\(`(\.\/[^`]+)`,`(https:\/\/framerusercontent\.com\/[^`]+)`\)(\.href\.replace\(`\/modules\/`,`\/cms\/`\))?/g,
    (m, rel, base, toCms) => {
      const remote = new URL(rel, base).href;
      enqueue(toCms ? remote.replace("/modules/", "/cms/") : remote);
      patchCounts.cmsBase++;
      return `new URL(\`${rel}\`,location.origin+\`${webPath(localPathFor(base))}\`)${toCms ?? ""}`;
    }
  );
  // CMS loader asks Framer's server for byte ranges via `?range=a-b,c-d`. Static hosts can't do that,
  // so fetch the whole file once (cached) and slice the ranges in the browser.
  text = text.replace(
    /for\(let (\w+) of (\w+)\)(\w+)\.push\(`\$\{\1\.from\}-\$\{\1\.to-1\}`\),(\w+)\+=\1\.to-\1\.from;let (\w+)=new URL\((\w+)\),(\w+)=\3\.join\(`,`\);\5\.searchParams\.set\(`range`,\7\);let (\w+)=await \w+\(\5\);if\(\8\.status!==200\)throw Error\(`Request failed: \$\{\8\.status\} \$\{\8\.statusText\}`\);let (\w+)=await \8\.arrayBuffer\(\),(\w+)=new Uint8Array\(\9\);/g,
    (m, it, ranges, parts, total, _u, url, _o, _s, buf, out) => {
      patchCounts.cmsRange++;
      return (
        `for(let ${it} of ${ranges})${parts}.push(\`\${${it}.from}-\${${it}.to-1}\`),${total}+=${it}.to-${it}.from;` +
        `let ${buf}=await((globalThis.__cmsFiles??={})[String(${url})]??=fetch(String(${url})).then(r=>{if(r.status!==200)throw Error(\`Request failed: \${r.status}\`);return r.arrayBuffer()})),` +
        `__all=new Uint8Array(${buf}),${out}=new Uint8Array(${total}),__off=0;` +
        `for(let __r of ${ranges})${out}.set(__all.subarray(__r.from,__r.to),__off),__off+=__r.to-__r.from;`
      );
    }
  );
  // Don't load Framer's on-page editor toolbar from framer.com.
  text = text.replace(/EditorBar:(\w+)===void 0\?void 0:/g, () => {
    patchCounts.editorBar++;
    return "EditorBar:void 0,__disabledEditorBar:";
  });
  return text;
}

async function get(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (i === 2) throw e;
    }
  }
}

// Framer's runtime calls `new URL(src)` on asset links, which assumes they are absolute.
// Resolve our root-relative "/assets/..." links against the current origin instead.
const URL_SHIM = `<script>(()=>{const U=URL,f=(u,b)=>b===void 0&&typeof u=="string"&&u.startsWith("/assets/")?location.origin:b;class L extends U{constructor(u,b){super(u,f(u,b))}static canParse(u,b){return U.canParse(u,f(u,b))}static parse(u,b){return U.parse(u,f(u,b))}}window.URL=L})()</script>`;

function cleanHtml(html) {
  return html
    .replace(/<meta charset="utf-8">/i, (m) => m + URL_SHIM)
    // Framer analytics
    .replace(/<script[^>]*events\.framer\.com[^>]*><\/script>/g, "")
    // Framer editor bar loader
    .replace(/<script>[^<]*framer\.com\/edit\/init\.mjs[^<]*<\/script>/g, "")
    // Hide the "Made in Framer" badge (kept in the DOM so React hydration still matches)
    .replace("</head>", "<style>#__framer-badge-container{display:none!important}</style></head>")
    .replace(/<meta name="generator"[^>]*>/g, "")
    .replaceAll(ORIGIN, SITE_URL);
}

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  for (const p of PAGES) {
    const html = (await get(ORIGIN + p)).toString("utf8");
    const out = rewrite(cleanHtml(html), null);
    const file = p === "/" ? "index.html" : p.slice(1) + ".html";
    await fs.writeFile(path.join(OUT, file), out);
    console.log("page", p, "->", file);
  }
  // Framer's own 404 page is generic Framer branding; use ours.
  await fs.copyFile("404.html", path.join(OUT, "404.html"));

  // Crawl assets breadth-first; text assets are scanned for more URLs.
  let pending;
  while ((pending = [...queue.keys()].filter((u) => !done.has(u))).length) {
    await Promise.all(
      pending.map(async (remote) => {
        done.add(remote);
        const local = queue.get(remote);
        try {
          let buf = await get(remote);
          if (isText(local)) {
            let t = buf.toString("utf8");
            if (/\.(mjs|js)$/.test(local)) t = patchJs(t);
            buf = Buffer.from(rewrite(t, remote).replaceAll(ORIGIN, SITE_URL));
          } else if (local.endsWith(".framercms")) buf = rewriteBinary(buf);
          const dest = path.join(OUT, local);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.writeFile(dest, buf);
        } catch (e) {
          failed.push(`${remote} (${e.message})`);
        }
      })
    );
    console.log("assets downloaded:", done.size);
  }

  await fs.writeFile(path.join(OUT, ".nojekyll"), "");
  await fs.writeFile(path.join(OUT, "CNAME"), new URL(SITE_URL).hostname + "\n");
  console.log("runtime patches applied:", patchCounts);
  if (!patchCounts.cmsRange || !patchCounts.editorBar) console.log("WARNING: a Framer runtime patch did not match — Framer may have changed its code.");
  if (failed.length) console.log("\nFAILED:\n" + failed.join("\n"));
  console.log("\nDone →", OUT);
}

main();
