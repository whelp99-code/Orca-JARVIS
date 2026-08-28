const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;

export function electronUnavailableHtml(code) {
  const safe = SAFE_CODE.test(code) ? code : "LINUX_AUTHORITY_UNAVAILABLE";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>JARVIS unavailable</title>
  <style>
    :root {
      color-scheme: dark;
      --color-canvas: #0b0e11;
      --color-surface: #11161a;
      --color-border: #29323a;
      --color-text: #edf2f5;
      --color-text-muted: #a3afb8;
      --color-danger: #e17f78;
      --color-focus: #b1e1eb;
      --font-sans: "Avenir Next", Avenir, "Segoe UI", "Noto Sans CJK KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
      --font-mono: "SFMono-Regular", Consolas, "Liberation Mono", "Noto Sans Mono CJK KR", monospace;
      --type-body: 0.9375rem;
      --type-panel: 1rem;
      --type-title: clamp(1.5rem, 2.5vw, 2rem);
      --line-tight: 1.2;
      --line-body: 1.5;
      --weight-regular: 400;
      --weight-medium: 600;
      --space-3: 0.75rem;
      --space-4: 1rem;
      --space-6: 1.5rem;
      --size-reading: 40rem;
      --border-width: 1px;
      --radius: 0.25rem;
    }

    * {
      box-sizing: border-box;
    }

    html {
      background: var(--color-canvas);
    }

    body {
      display: grid;
      min-block-size: 100dvb;
      margin: 0;
      place-items: center;
      overflow-x: hidden;
      padding: var(--space-4);
      background: var(--color-canvas);
      color: var(--color-text);
      font-family: var(--font-sans);
      font-size: var(--type-body);
      font-weight: var(--weight-regular);
      line-height: var(--line-body);
    }

    main {
      inline-size: 100%;
      max-inline-size: var(--size-reading);
      min-inline-size: 0;
    }

    .authority-status {
      display: grid;
      inline-size: 100%;
      max-inline-size: var(--size-reading);
      min-inline-size: 0;
      gap: var(--space-4);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius);
      padding: var(--space-6);
      overflow-wrap: anywhere;
      background: var(--color-surface);
    }

    h1,
    p,
    code {
      margin: 0;
    }

    h1 {
      color: var(--color-text);
      font-size: var(--type-title);
      font-weight: var(--weight-medium);
      line-height: var(--line-tight);
    }

    .authority-code {
      border-inline-start: var(--border-width) solid var(--color-danger);
      padding-inline-start: var(--space-3);
      color: var(--color-danger);
      font-family: var(--font-mono);
      font-size: var(--type-panel);
      font-weight: var(--weight-medium);
      line-height: var(--line-body);
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .authority-detail {
      color: var(--color-text-muted);
    }
  </style>
</head>
<body data-surface="electron" data-authority-mode="remote-only" data-execution-mode="remote-only">
  <main>
    <section class="authority-status" role="alert" data-error-code="${safe}">
      <h1>Linux authority unavailable</h1>
      <code class="authority-code">${safe}</code>
      <p class="authority-detail">No local authority or execution fallback is available.</p>
    </section>
  </main>
</body>
</html>`;
}
