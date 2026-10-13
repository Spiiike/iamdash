'use strict';

/*
 * The site shell.
 *
 * This is the redesign: one navy field, two typefaces, hairlines instead of
 * boxes. It replaces the page() helper currently defined inside server.js, and
 * keeps the same signature — page(title, bodyHtml) — so every existing router
 * that was handed page() keeps working without being touched.
 *
 * The palette and both typefaces are carried over from the resume at
 * glasscliff.online, so the two sites read as one person's work: the same
 * web-safe navy (#000066), the same cream (#fffef0), Georgia for anything a
 * person reads and Courier New only where monospace carries meaning.
 */

function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NAV = [
  { href: '/', label: 'labs', key: 'labs' },
  { href: 'https://glasscliff.online/blog.html', label: 'write-up', key: 'blog' },
  { href: 'https://glasscliff.online/', label: 'resume', key: 'resume' },
];

/**
 * @param {object} [opts]
 * @param {string} [opts.cssHref]  where the shared stylesheet is served
 */
function createPage({ cssHref = '/labs/assets/glasscliff.css' } = {}) {
  /**
   * @param {string} title     full <title>, e.g. 'Reconciliation · Glasscliff labs'
   * @param {string} bodyHtml  the page fragment
   * @param {object} [o]
   * @param {string} [o.description]
   * @param {string} [o.current]  nav key to mark aria-current
   */
  return function page(title, bodyHtml, o = {}) {
    const nav = NAV.map(
      (n) =>
        `<a href="${esc(n.href)}"${o.current === n.key ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`
    ).join('');

    const description = o.description
      ? `\n<meta name="description" content="${esc(o.description)}">`
      : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">${description}
<title>${esc(title)}</title>
<link rel="stylesheet" href="${esc(cssHref)}">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="wrap">

  <header class="masthead">
    <a class="mark" href="/"><b>glasscliff</b>.online</a>
    <nav class="nav" aria-label="Site">${nav}</nav>
  </header>

  <main id="main">
${bodyHtml}
  </main>

  <footer class="foot">
    <span>Antalon Jackson Jr</span>
    <nav aria-label="Elsewhere">
      <a href="/">labs</a>
      <a href="https://glasscliff.online/blog.html">web log</a>
      <a href="https://github.com/Spiiike">github</a>
      <a href="https://github.com/Spiiike/iamdash">source</a>
      <a href="https://www.linkedin.com/in/antalon-jackson-jr-71a23bbb/">linkedin</a>
    </nav>
  </footer>

</div>
</body>
</html>`;
  };
}

module.exports = { createPage, esc, NAV };
