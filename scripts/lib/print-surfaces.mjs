const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

export function electronUnavailableHtml(code) {
  const safe = SAFE_CODE.test(code) ? code : "LINUX_AUTHORITY_UNAVAILABLE";
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><title>JARVIS unavailable</title></head>',
    '<body data-surface="electron" data-authority-mode="remote-only">',
    "<main><h1>Linux authority unavailable</h1>",
    `<p role="alert" data-error-code="${safe}">${safe}</p>`,
    "<p>No local authority or execution fallback is available.</p></main></body></html>",
  ].join("");
}
