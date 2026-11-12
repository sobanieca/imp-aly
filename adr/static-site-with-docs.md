# One static site with the landing page, the docs and the console

## Context

The docs in `docs/` are for a person who runs the server. Before, nothing published them. The
landing page linked to the Markdown files on GitHub, and a reader without access to the repo could
not open them. The landing page was one hand-written HTML file with its own look, and it loaded its
fonts from Google Fonts. The site of imp has a look that the imp-aly console and site can share.

## Decision

**`cargo xtask build-site` writes one static site into `site/dist/`. It has the landing page, a page
for each file of `docs/`, the console, `install.sh` and `versions.json`. GitHub Pages serves it at
`https://aly.imp-ui.com/`. `cargo site` builds the same site and serves it on localhost with
`rfm`.**

- The build renders `docs/*.md` with `pulldown-cmark` into `/docs/<name>/index.html`, in the order
  of `PAGE_ORDER` in `xtask/src/site.rs`. A page that is not in the list fails the build.
- A link between pages, such as `apps.md#segments`, becomes a relative link to the page folder. The
  build fails on a link to a missing page, a missing heading, or a file outside `docs/`. So a link
  works on GitHub and on the site.
- A heading gets the same id as on GitHub, so an anchor stays the same.
- The build highlights the code blocks of `sh`, `json` and `js` at build time. The page has no
  highlight script.
- Every link of the site is relative. So the site works on any host, such as `aly.imp-ui.com` and
  localhost.
- The look follows the site of imp: the ink bar with the three colour bars, the grid in the corner,
  the docs nav with square marks, and the paper card. The fonts are the fonts of the console, from
  `console/public/fonts/`. The site sends no request to another origin.
- A small script in the head reads the remembered colour scheme before the first paint, so a dark
  page never flashes light. The toggle in the bar switches the scheme.
- The console of the site uses the environment `site` (`IMP_BASEPATH=/console`), on GitHub Pages
  and for `cargo site`. The build copies the `index.html` of the console to `404.html`.

## Consequences

- `xtask/` uses `pulldown-cmark`, a crate that the server does not use. The binary stays the same.
- A new page of `docs/` needs an entry in `PAGE_ORDER`.
- A broken link between docs fails the Pages job, so it does not reach the site.
- `cargo site` needs `imp` and `rfm` on the machine.
