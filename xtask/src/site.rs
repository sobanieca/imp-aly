use crate::highlight::{escape, highlight};
use pulldown_cmark::{CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::process::Command;

pub const SITE_URL: &str = "https://sobanieca.github.io/imp-aly";

const REPO_URL: &str = "https://github.com/sobanieca/imp-aly";

const TITLE_PREFIX: &str = "imp-aly - ";

const DESCRIPTION_LIMIT: usize = 160;

const PAGE_ORDER: &[&str] = &[
    "introduction",
    "getting-started",
    "collect",
    "apps",
    "query",
    "console",
    "storage",
    "backup",
    "security",
    "update",
    "cli",
];

const STATIC_FILES: &[(&str, &str)] = &[
    ("site/site.css", "site.css"),
    ("site/site.js", "site.js"),
    ("site/mark.svg", "mark.svg"),
    ("install.sh", "install.sh"),
];

const OVERVIEW: &str = "site/overview.html";

const FONTS: &str = "console/public/fonts";

const GEOMETRY_SQUARES: &[(&str, u8, u8, u8)] = &[
    ("ink", 0, 0, 2),
    ("main-3", 2, 0, 1),
    ("main-2", 2, 1, 1),
    ("main-1", 2, 2, 1),
    ("outline", 0, 3, 1),
    ("faint", 4, 1, 1),
];

const SUN_ICON: &str = "<circle cx=\"12\" cy=\"12\" r=\"4\"/><path d=\"M12 2v2\"/>\
    <path d=\"M12 20v2\"/><path d=\"m4.93 4.93 1.41 1.41\"/><path d=\"m17.66 17.66 1.41 1.41\"/>\
    <path d=\"M2 12h2\"/><path d=\"M20 12h2\"/><path d=\"m6.34 17.66-1.41 1.41\"/>\
    <path d=\"m19.07 4.93-1.41 1.41\"/>";

const MOON_ICON: &str = "<path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803\
    a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\"/>";

const EARLY_SCRIPT: &str = "<script>
      let scheme = null
      try {
        scheme = localStorage.getItem('imp-aly.site.scheme')
      } catch {
        scheme = null
      }
      if (scheme !== 'light' && scheme !== 'dark') {
        scheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      }
      document.documentElement.dataset.scheme = scheme
    </script>";

#[derive(Clone, Copy, PartialEq)]
pub enum Target {
    Local,
    Pages,
}

impl Target {
    fn console_env(self) -> &'static str {
        match self {
            Target::Local => "site",
            Target::Pages => "pages",
        }
    }
}

struct DocLink {
    slug: String,
    anchor: String,
}

struct Rendered {
    html: String,
    title: String,
    description: String,
    ids: HashSet<String>,
    links: Vec<DocLink>,
}

struct Doc {
    slug: String,
    label: String,
    rendered: Rendered,
}

struct Page {
    route: String,
    title: String,
    description: String,
    main: String,
}

fn heading_slug(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter_map(|char| match char {
            ' ' => Some('-'),
            char if char.is_alphanumeric() || char == '-' || char == '_' => Some(char),
            _ => None,
        })
        .collect()
}

fn unique_id(slug: String, ids: &mut HashSet<String>) -> String {
    let mut id = slug.clone();
    let mut count = 0;
    while ids.contains(&id) {
        count += 1;
        id = format!("{slug}-{count}");
    }
    ids.insert(id.clone());
    id
}

fn is_external(target: &str) -> bool {
    let Some((scheme, _)) = target.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|char| char.is_ascii_alphanumeric() || "+.-".contains(char))
}

fn doc_link(href: &str) -> Option<DocLink> {
    let (path, anchor) = href.split_once('#').unwrap_or((href, ""));
    let slug = path.strip_suffix(".md")?;
    let valid = !slug.is_empty()
        && slug
            .chars()
            .all(|char| char.is_ascii_lowercase() || char.is_ascii_digit() || char == '-');
    valid.then(|| DocLink {
        slug: slug.to_string(),
        anchor: anchor.to_string(),
    })
}

fn link_target(slug: &str, anchor: &str, base: &str) -> String {
    let hash = if anchor.is_empty() {
        String::new()
    } else {
        format!("#{anchor}")
    };
    format!("{base}docs/{slug}/{hash}")
}

fn link_open(
    href: &str,
    title: &str,
    current: &str,
    base: &str,
    links: &mut Vec<DocLink>,
) -> Result<String, String> {
    let target = if let Some(anchor) = href.strip_prefix('#') {
        links.push(DocLink {
            slug: current.to_string(),
            anchor: anchor.to_string(),
        });
        href.to_string()
    } else if let Some(link) = doc_link(href) {
        let target = link_target(&link.slug, &link.anchor, base);
        links.push(link);
        target
    } else if is_external(href) {
        href.to_string()
    } else {
        return Err(format!(
            "docs/{current}.md links to {href}, which is not a page of docs/"
        ));
    };
    let mut attributes = vec![format!("href=\"{}\"", escape(&target))];
    if !title.is_empty() {
        attributes.push(format!("title=\"{}\"", escape(title)));
    }
    if is_external(&target) {
        attributes.push("target=\"_blank\" rel=\"noopener\"".to_string());
    }
    Ok(format!("<a {}>", attributes.join(" ")))
}

fn shorten(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.len() <= DESCRIPTION_LIMIT {
        return text;
    }
    let cut = &text[..DESCRIPTION_LIMIT - 3];
    let cut = cut.rsplit_once(' ').map_or(cut, |(head, _)| head);
    format!("{cut}...")
}

struct Heading<'a> {
    level: HeadingLevel,
    text: String,
    events: Vec<Event<'a>>,
}

fn render_markdown(text: &str, current: &str, base: &str) -> Result<Rendered, String> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    let mut events: Vec<Event> = Vec::new();
    let mut ids = HashSet::new();
    let mut links = Vec::new();
    let mut title = String::new();
    let mut description: Option<String> = None;
    let mut paragraph: Option<String> = None;
    let mut heading: Option<Heading> = None;
    let mut code: Option<(String, String)> = None;
    for event in Parser::new_ext(text, options) {
        if let Some((language, source)) = code.as_mut() {
            match event {
                Event::Text(part) => source.push_str(&part),
                Event::End(TagEnd::CodeBlock) => {
                    let source = source.strip_suffix('\n').unwrap_or(source);
                    events.push(Event::Html(CowStr::from(format!(
                        "<pre class=\"code\"><code>{}</code></pre>\n",
                        highlight(source, language)
                    ))));
                    code = None;
                }
                _ => {}
            }
            continue;
        }
        if let Some(paragraph) = paragraph.as_mut()
            && let Event::Text(part) | Event::Code(part) = &event
        {
            paragraph.push_str(part);
        }
        let rewritten = match event {
            Event::Start(Tag::CodeBlock(kind)) => {
                let language = match kind {
                    CodeBlockKind::Fenced(info) => {
                        info.split_whitespace().next().unwrap_or("").to_string()
                    }
                    CodeBlockKind::Indented => String::new(),
                };
                code = Some((language, String::new()));
                continue;
            }
            Event::Start(Tag::Paragraph) if description.is_none() && heading.is_none() => {
                paragraph = Some(String::new());
                Event::Start(Tag::Paragraph)
            }
            Event::End(TagEnd::Paragraph) if paragraph.is_some() => {
                description = paragraph.take().map(|text| shorten(&text));
                Event::End(TagEnd::Paragraph)
            }
            Event::Start(Tag::Heading { level, .. }) => {
                heading = Some(Heading {
                    level,
                    text: String::new(),
                    events: Vec::new(),
                });
                continue;
            }
            Event::End(TagEnd::Heading(_)) => {
                let Some(done) = heading.take() else {
                    continue;
                };
                let id = unique_id(heading_slug(&done.text), &mut ids);
                if done.level == HeadingLevel::H1 && title.is_empty() {
                    title = done.text.clone();
                }
                let mut inner = String::new();
                pulldown_cmark::html::push_html(&mut inner, done.events.into_iter());
                let level = done.level as u8;
                Event::Html(CowStr::from(format!(
                    "<h{level} id=\"{id}\">{inner}</h{level}>\n"
                )))
            }
            Event::Start(Tag::Link {
                dest_url, title, ..
            }) => Event::InlineHtml(CowStr::from(link_open(
                &dest_url, &title, current, base, &mut links,
            )?)),
            Event::End(TagEnd::Link) => Event::InlineHtml(CowStr::from("</a>")),
            Event::Text(part)
                if heading
                    .as_ref()
                    .is_some_and(|heading| heading.level == HeadingLevel::H1) =>
            {
                let part = part.strip_prefix(TITLE_PREFIX).unwrap_or(&part).to_string();
                Event::Text(CowStr::from(part))
            }
            other => other,
        };
        match heading.as_mut() {
            Some(heading) => {
                if let Event::Text(part) | Event::Code(part) = &rewritten {
                    heading.text.push_str(part);
                }
                heading.events.push(rewritten);
            }
            None => events.push(rewritten),
        }
    }
    let mut html = String::new();
    pulldown_cmark::html::push_html(&mut html, events.into_iter());
    Ok(Rendered {
        html,
        title,
        description: description.unwrap_or_default(),
        ids,
        links,
    })
}

fn render_docs(root: &Path) -> Result<Vec<Doc>, String> {
    let mut found = HashSet::new();
    let entries = std::fs::read_dir(root.join("docs")).map_err(|error| error.to_string())?;
    for entry in entries {
        let path = entry.map_err(|error| error.to_string())?.path();
        if path.extension().is_some_and(|extension| extension == "md")
            && let Some(stem) = path.file_stem()
        {
            found.insert(stem.to_string_lossy().into_owned());
        }
    }
    for slug in &found {
        if !PAGE_ORDER.contains(&slug.as_str()) {
            return Err(format!(
                "docs/{slug}.md is not in PAGE_ORDER of xtask/src/site.rs"
            ));
        }
    }
    let mut docs = Vec::new();
    for slug in PAGE_ORDER {
        if !found.contains(*slug) {
            return Err(format!("docs/{slug}.md is missing"));
        }
        let path = root.join("docs").join(format!("{slug}.md"));
        let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let rendered = render_markdown(&text, slug, "../../")?;
        let label = rendered.title.clone();
        docs.push(Doc {
            slug: slug.to_string(),
            label,
            rendered,
        });
    }
    check_links(&docs)?;
    Ok(docs)
}

fn check_links(docs: &[Doc]) -> Result<(), String> {
    let ids: HashMap<&str, &HashSet<String>> = docs
        .iter()
        .map(|doc| (doc.slug.as_str(), &doc.rendered.ids))
        .collect();
    for doc in docs {
        for link in &doc.rendered.links {
            let Some(target) = ids.get(link.slug.as_str()) else {
                return Err(format!(
                    "docs/{}.md links to {}.md, which does not exist",
                    doc.slug, link.slug
                ));
            };
            if !link.anchor.is_empty() && !target.contains(&link.anchor) {
                return Err(format!(
                    "docs/{}.md links to {}.md#{}, which has no such heading",
                    doc.slug, link.slug, link.anchor
                ));
            }
        }
    }
    Ok(())
}

fn base_of(route: &str) -> String {
    "../".repeat(route.matches('/').count())
}

fn nav_link(href: &str, label: &str, current: bool) -> String {
    let current = if current {
        " aria-current=\"page\""
    } else {
        ""
    };
    format!(
        "<a href=\"{}\"{current}>{}</a>",
        escape(href),
        escape(label)
    )
}

fn svg_icon(class: &str, elements: &str) -> String {
    format!(
        "<svg class=\"{class}\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" \
         stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" \
         aria-hidden=\"true\">{elements}</svg>"
    )
}

fn bar(route: &str) -> String {
    let base = base_of(route);
    let home = if base.is_empty() { "./" } else { &base };
    let sections = [
        nav_link(home, "Overview", route.is_empty()),
        nav_link(&format!("{base}docs/"), "Docs", route.starts_with("docs/")),
        nav_link(&format!("{base}console/"), "Console", false),
        nav_link(REPO_URL, "GitHub", false),
    ];
    format!(
        "<header class=\"bar\"><a class=\"brand\" href=\"{home}\" aria-label=\"imp-aly - home\">\
         <img src=\"{base}mark.svg\" alt=\"\"><span>imp-aly</span></a>\
         <nav aria-label=\"Sections\"><ul class=\"links\">{}</ul></nav>\
         <div class=\"end\"><button class=\"scheme\" type=\"button\" \
         aria-label=\"Switch the theme\">{}{}</button>\
         <span class=\"version\">v{}</span>\
         <div class=\"bars\" aria-hidden=\"true\"><div class=\"main-1\"></div>\
         <div class=\"main-2\"></div><div class=\"main-3\"></div></div></div></header>",
        sections
            .iter()
            .map(|link| format!("<li>{link}</li>"))
            .collect::<String>(),
        svg_icon("sun", SUN_ICON),
        svg_icon("moon", MOON_ICON),
        imp_aly::VERSION,
    )
}

fn corner() -> String {
    let squares: String = GEOMETRY_SQUARES
        .iter()
        .map(|(tone, column, row, span)| {
            format!(
                "<div class=\"square {tone}\" \
                 style=\"--column: {column}; --row: {row}; --span: {span}\"></div>"
            )
        })
        .collect();
    format!(
        "<div class=\"corner\" aria-hidden=\"true\"><div class=\"geometry\">\
         <div class=\"grid\"></div>{squares}</div></div>"
    )
}

fn docs_nav(docs: &[Doc], current: Option<&str>, base: &str) -> String {
    let items: String = docs
        .iter()
        .map(|doc| {
            let href = link_target(&doc.slug, "", base);
            let link = nav_link(&href, &doc.label, current == Some(doc.slug.as_str()));
            format!("<li>{link}</li>")
        })
        .collect();
    format!("<nav aria-label=\"Documentation pages\"><ul class=\"pages\">{items}</ul></nav>")
}

fn docs_index(docs: &[Doc]) -> String {
    let items: String = docs
        .iter()
        .map(|doc| {
            format!(
                "<li>{} - {}</li>",
                nav_link(&link_target(&doc.slug, "", "../"), &doc.label, false),
                escape(&doc.rendered.description)
            )
        })
        .collect();
    format!(
        "<h1>Docs</h1><p>These pages are for a person who runs the server and sends records \
         from an imp app. <code>imp-aly help</code> shows the same commands in the terminal.</p>\
         <ul>{items}</ul>"
    )
}

fn pages_of(docs: &[Doc], overview: &str) -> Vec<Page> {
    let mut pages = vec![
        Page {
            route: String::new(),
            title: "imp-aly - analytics for imp apps, on your own VPS".to_string(),
            description: "imp-aly is a small analytics server for imp apps. Run it on your own \
                          VPS. One binary, no database, and the data stays on your disk."
                .to_string(),
            main: format!("<div class=\"overview\">{overview}</div>"),
        },
        Page {
            route: "docs/".to_string(),
            title: "Docs - imp-aly".to_string(),
            description: "The documentation of imp-aly: install the server, collect records, \
                          register apps, query, store, back up and secure the data."
                .to_string(),
            main: format!(
                "<div class=\"docs\">{}<article class=\"paper md\">{}</article></div>",
                docs_nav(docs, None, "../"),
                docs_index(docs)
            ),
        },
    ];
    for doc in docs {
        pages.push(Page {
            route: format!("docs/{}/", doc.slug),
            title: format!("{} - imp-aly", doc.label),
            description: doc.rendered.description.clone(),
            main: format!(
                "<div class=\"docs\">{}<article class=\"paper md\">{}</article></div>",
                docs_nav(docs, Some(&doc.slug), "../../"),
                doc.rendered.html
            ),
        });
    }
    pages
}

fn document_of(page: &Page) -> String {
    let base = base_of(&page.route);
    let url = format!("{SITE_URL}/{}", page.route);
    let title = escape(&page.title);
    let description = escape(&page.description);
    format!(
        "<!doctype html>
<html lang=\"en\">
  <head>
    <meta charset=\"utf-8\">
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">
    <title>{title}</title>
    <meta name=\"description\" content=\"{description}\">
    <meta property=\"og:type\" content=\"website\">
    <meta property=\"og:title\" content=\"{title}\">
    <meta property=\"og:description\" content=\"{description}\">
    <meta property=\"og:url\" content=\"{url}\">
    <link rel=\"canonical\" href=\"{url}\">
    <link rel=\"icon\" href=\"{base}mark.svg\" type=\"image/svg+xml\">
    <link rel=\"preload\" href=\"{base}fonts/ibm-plex-sans.woff2\" as=\"font\" type=\"font/woff2\" crossorigin>
    <link rel=\"stylesheet\" href=\"{base}fonts/fonts.css\">
    <link rel=\"stylesheet\" href=\"{base}site.css\">
    {EARLY_SCRIPT}
  </head>
  <body>
    {}
    <div class=\"canvas\">{}<main>{}</main></div>
    <script type=\"module\" src=\"{base}site.js\"></script>
  </body>
</html>
",
        bar(&page.route),
        corner(),
        page.main
    )
}

fn sitemap_of(pages: &[Page]) -> String {
    let urls: String = pages
        .iter()
        .map(|page| format!("  <url><loc>{SITE_URL}/{}</loc></url>\n", page.route))
        .collect();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n{urls}</urlset>\n"
    )
}

fn write_file(path: &Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, text).map_err(|error| format!("{}: {error}", path.display()))
}

fn copy_file(from: &Path, to: &Path) -> Result<(), String> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::copy(from, to)
        .map(|_| ())
        .map_err(|error| format!("{}: {error}", from.display()))
}

fn copy_folder(from: &Path, to: &Path) -> Result<(), String> {
    let entries =
        std::fs::read_dir(from).map_err(|error| format!("{}: {error}", from.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry.file_type().is_ok_and(|kind| kind.is_file()) {
            copy_file(&entry.path(), &to.join(entry.file_name()))?;
        }
    }
    Ok(())
}

fn build_console(dist: &Path, target: Target) -> Result<(), String> {
    let output = dist.join("console");
    let output = output.to_string_lossy();
    let args = [
        "build",
        "--pwa",
        "--env",
        target.console_env(),
        "--output",
        &output,
    ];
    if !crate::imp(&args) {
        return Err("imp build of the console failed".to_string());
    }
    copy_file(
        &dist.join("console").join("index.html"),
        &dist.join("404.html"),
    )
}

pub fn build_site(target: Target) -> Result<(), String> {
    let root = crate::root();
    let dist = root.join("site").join("dist");
    let docs = render_docs(&root)?;
    let overview = std::fs::read_to_string(root.join(OVERVIEW))
        .map_err(|error| format!("{OVERVIEW}: {error}"))?;
    let pages = pages_of(&docs, &overview);
    match std::fs::remove_dir_all(&dist) {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            return Err(format!("{}: {error}", dist.display()));
        }
        _ => {}
    }
    for page in &pages {
        write_file(
            &dist.join(&page.route).join("index.html"),
            &document_of(page),
        )?;
    }
    write_file(&dist.join("sitemap.xml"), &sitemap_of(&pages))?;
    write_file(
        &dist.join("versions.json"),
        &crate::versions_manifest_text(),
    )?;
    for (from, to) in STATIC_FILES {
        copy_file(&root.join(from), &dist.join(to))?;
    }
    copy_folder(&root.join(FONTS), &dist.join("fonts"))?;
    build_console(&dist, target)?;
    println!("site: {} pages written into site/dist/", pages.len());
    Ok(())
}

pub fn serve_site() -> Result<(), String> {
    build_site(Target::Local)?;
    let status = Command::new("rfm")
        .current_dir(crate::root().join("site").join("dist"))
        .status()
        .map_err(|error| {
            format!(
                "cannot run rfm ({error}) - install it from \
                 https://sobanieca.github.io/remote-file-manager/"
            )
        })?;
    if status.success() {
        Ok(())
    } else {
        Err("rfm failed".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_heading_slug_follows_the_rules_of_github() {
        assert_eq!(
            heading_slug("Update the build file"),
            "update-the-build-file"
        );
        assert_eq!(
            heading_slug("CORS and allowed origins"),
            "cors-and-allowed-origins"
        );
        assert_eq!(
            heading_slug("The `app-analytics.json` file"),
            "the-app-analyticsjson-file"
        );
    }

    #[test]
    fn a_second_heading_with_the_same_text_gets_a_number() {
        let mut ids = HashSet::new();
        assert_eq!(unique_id("a".to_string(), &mut ids), "a");
        assert_eq!(unique_id("a".to_string(), &mut ids), "a-1");
        assert_eq!(unique_id("a".to_string(), &mut ids), "a-2");
    }

    #[test]
    fn links_to_docs_point_at_the_page_folders() {
        let rendered = render_markdown(
            "# imp-aly - Apps\n\nSee [the checks](collect.md#the-checks), [below](#segments) \
             and [imp](https://example.com/).\n\n## Segments\n",
            "apps",
            "../../",
        )
        .unwrap();
        assert_eq!(rendered.title, "Apps");
        assert!(rendered.html.contains("<h1 id=\"apps\">Apps</h1>"));
        assert!(
            rendered
                .html
                .contains("href=\"../../docs/collect/#the-checks\"")
        );
        assert!(rendered.html.contains("href=\"#segments\""));
        assert!(
            rendered
                .html
                .contains("href=\"https://example.com/\" target=\"_blank\" rel=\"noopener\"")
        );
        assert!(rendered.ids.contains("segments"));
        assert_eq!(rendered.links.len(), 2);
        assert_eq!(rendered.description, "See the checks, below and imp.");
    }

    #[test]
    fn a_link_to_a_file_outside_docs_fails() {
        let error = render_markdown("[x](../src/main.rs)", "apps", "../../")
            .err()
            .unwrap();
        assert!(error.contains("../src/main.rs"));
    }

    #[test]
    fn a_code_block_is_highlighted() {
        let rendered = render_markdown("```sh\nls # list\n```\n", "apps", "").unwrap();
        assert_eq!(
            rendered.html,
            "<pre class=\"code\"><code>ls <span class=\"token-comment\"># list</span>\
             </code></pre>\n"
        );
    }

    #[test]
    fn a_long_description_is_cut_at_a_word() {
        let text = "word ".repeat(60);
        let short = shorten(&text);
        assert!(short.len() <= DESCRIPTION_LIMIT);
        assert!(short.ends_with("word..."));
    }

    #[test]
    fn the_base_climbs_one_folder_per_level() {
        assert_eq!(base_of(""), "");
        assert_eq!(base_of("docs/"), "../");
        assert_eq!(base_of("docs/apps/"), "../../");
    }
}
