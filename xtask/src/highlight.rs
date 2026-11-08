const JS_KEYWORDS: &[&str] = &[
    "async", "await", "break", "case", "catch", "class", "const", "continue", "default", "else",
    "export", "for", "from", "function", "if", "import", "in", "let", "new", "of", "return",
    "switch", "throw", "try", "typeof", "while",
];

const LITERALS: &[&str] = &["true", "false", "null", "undefined"];

pub fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn highlight(source: &str, language: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = Highlighted::default();
    match language {
        "sh" | "bash" | "shell" => shell(&chars, &mut out),
        "json" => json(&chars, &mut out),
        "js" | "javascript" => javascript(&chars, &mut out),
        _ => out.plain(&chars),
    }
    out.html
}

#[derive(Default)]
struct Highlighted {
    html: String,
}

impl Highlighted {
    fn token(&mut self, class: &str, chars: &[char]) {
        let text: String = chars.iter().collect();
        self.html.push_str(&format!(
            "<span class=\"token-{class}\">{}</span>",
            escape(&text)
        ));
    }

    fn plain(&mut self, chars: &[char]) {
        let text: String = chars.iter().collect();
        self.html.push_str(&escape(&text));
    }
}

fn string_end(chars: &[char], start: usize, backslash_escapes: bool) -> usize {
    let quote = chars[start];
    let mut index = start + 1;
    while index < chars.len() {
        if backslash_escapes && chars[index] == '\\' {
            index += 2;
            continue;
        }
        if chars[index] == quote {
            return index + 1;
        }
        index += 1;
    }
    chars.len()
}

fn line_end(chars: &[char], start: usize) -> usize {
    chars[start..]
        .iter()
        .position(|char| *char == '\n')
        .map_or(chars.len(), |offset| start + offset)
}

fn run_end(chars: &[char], start: usize, keep: impl Fn(char) -> bool) -> usize {
    chars[start..]
        .iter()
        .position(|char| !keep(*char))
        .map_or(chars.len(), |offset| start + offset)
}

fn at_word_start(chars: &[char], index: usize) -> bool {
    index == 0 || chars[index - 1].is_whitespace()
}

fn is_word_char(char: char) -> bool {
    char.is_ascii_alphanumeric() || char == '_' || char == '$'
}

fn shell(chars: &[char], out: &mut Highlighted) {
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        let next = chars.get(index + 1).copied();
        if char == '#' && at_word_start(chars, index) {
            let end = line_end(chars, index);
            out.token("comment", &chars[index..end]);
            index = end;
        } else if char == '\'' || char == '"' {
            let end = string_end(chars, index, char == '"');
            out.token("string", &chars[index..end]);
            index = end;
        } else if char == '$' && next.is_some_and(|next| next == '{') {
            let end = run_end(chars, index, |char| char != '}').min(chars.len() - 1) + 1;
            out.token("variable", &chars[index..end]);
            index = end;
        } else if char == '$' && next.is_some_and(|next| next.is_ascii_alphabetic() || next == '_')
        {
            let end = run_end(chars, index + 1, |char| {
                char.is_ascii_alphanumeric() || char == '_'
            });
            out.token("variable", &chars[index..end]);
            index = end;
        } else if char == '-'
            && at_word_start(chars, index)
            && next.is_some_and(|next| next == '-' || next.is_ascii_alphabetic())
        {
            let end = run_end(chars, index, |char| {
                char.is_ascii_alphanumeric() || char == '-' || char == '_'
            });
            out.token("attribute", &chars[index..end]);
            index = end;
        } else {
            let end = run_end(chars, index + 1, |char| {
                !matches!(char, '#' | '\'' | '"' | '$' | '-') && !char.is_whitespace()
            });
            let end = if char.is_whitespace() { index + 1 } else { end };
            out.plain(&chars[index..end]);
            index = end;
        }
    }
}

fn number_end(chars: &[char], start: usize) -> usize {
    run_end(chars, start + 1, |char| {
        char.is_ascii_digit() || matches!(char, '.' | 'e' | 'E' | '+' | '-' | '_')
    })
}

fn starts_number(chars: &[char], index: usize) -> bool {
    let char = chars[index];
    let follows_word = index > 0 && is_word_char(chars[index - 1]);
    !follows_word
        && (char.is_ascii_digit()
            || (char == '-' && chars.get(index + 1).is_some_and(char::is_ascii_digit)))
}

fn followed_by_colon(chars: &[char], start: usize) -> bool {
    chars[start..]
        .iter()
        .find(|char| !char.is_whitespace())
        .is_some_and(|char| *char == ':')
}

fn json(chars: &[char], out: &mut Highlighted) {
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        if char == '"' {
            let end = string_end(chars, index, true);
            let class = if followed_by_colon(chars, end) {
                "property"
            } else {
                "string"
            };
            out.token(class, &chars[index..end]);
            index = end;
        } else if starts_number(chars, index) {
            let end = number_end(chars, index);
            out.token("number", &chars[index..end]);
            index = end;
        } else if char.is_ascii_alphabetic() {
            let end = run_end(chars, index, |char| char.is_ascii_alphanumeric());
            let word: String = chars[index..end].iter().collect();
            if LITERALS.contains(&word.as_str()) {
                out.token("literal", &chars[index..end]);
            } else {
                out.plain(&chars[index..end]);
            }
            index = end;
        } else if matches!(char, '{' | '}' | '[' | ']' | ',' | ':') {
            out.token("punctuation", &chars[index..index + 1]);
            index += 1;
        } else {
            out.plain(&chars[index..index + 1]);
            index += 1;
        }
    }
}

fn javascript(chars: &[char], out: &mut Highlighted) {
    let mut index = 0;
    while index < chars.len() {
        let char = chars[index];
        let next = chars.get(index + 1).copied();
        if char == '/' && next == Some('/') {
            let end = line_end(chars, index);
            out.token("comment", &chars[index..end]);
            index = end;
        } else if char == '/' && next == Some('*') {
            let end = (index + 2..chars.len().saturating_sub(1))
                .find(|at| chars[*at] == '*' && chars[*at + 1] == '/')
                .map_or(chars.len(), |at| at + 2);
            out.token("comment", &chars[index..end]);
            index = end;
        } else if matches!(char, '\'' | '"' | '`') {
            let end = string_end(chars, index, true);
            out.token("string", &chars[index..end]);
            index = end;
        } else if starts_number(chars, index) && char != '-' {
            let end = number_end(chars, index);
            out.token("number", &chars[index..end]);
            index = end;
        } else if char.is_ascii_alphabetic() || char == '_' || char == '$' {
            let end = run_end(chars, index, is_word_char);
            let word: String = chars[index..end].iter().collect();
            let class = if JS_KEYWORDS.contains(&word.as_str()) {
                Some("keyword")
            } else if LITERALS.contains(&word.as_str()) {
                Some("literal")
            } else if chars.get(end) == Some(&'(') {
                Some("function")
            } else if followed_by_colon(chars, end) {
                Some("property")
            } else {
                None
            };
            match class {
                Some(class) => out.token(class, &chars[index..end]),
                None => out.plain(&chars[index..end]),
            }
            index = end;
        } else if matches!(
            char,
            '{' | '}' | '[' | ']' | '(' | ')' | ',' | ';' | '.' | ':'
        ) {
            out.token("punctuation", &chars[index..index + 1]);
            index += 1;
        } else {
            out.plain(&chars[index..index + 1]);
            index += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_only_escaped() {
        assert_eq!(
            highlight("a < b & \"c\"", ""),
            "a &lt; b &amp; &quot;c&quot;"
        );
    }

    #[test]
    fn shell_marks_comments_strings_options_and_variables() {
        assert_eq!(
            highlight("imp-aly app add --origins 'x' $HOME # note", "sh"),
            "imp-aly app add <span class=\"token-attribute\">--origins</span> \
             <span class=\"token-string\">'x'</span> \
             <span class=\"token-variable\">$HOME</span> \
             <span class=\"token-comment\"># note</span>"
        );
    }

    #[test]
    fn a_hash_inside_a_word_is_not_a_comment_in_shell() {
        assert_eq!(highlight("a#b", "sh"), "a#b");
    }

    #[test]
    fn json_tells_keys_from_values() {
        assert_eq!(
            highlight("{\"a\": 1, \"b\": [\"x\", null]}", "json"),
            "<span class=\"token-punctuation\">{</span>\
             <span class=\"token-property\">&quot;a&quot;</span>\
             <span class=\"token-punctuation\">:</span> \
             <span class=\"token-number\">1</span>\
             <span class=\"token-punctuation\">,</span> \
             <span class=\"token-property\">&quot;b&quot;</span>\
             <span class=\"token-punctuation\">:</span> \
             <span class=\"token-punctuation\">[</span>\
             <span class=\"token-string\">&quot;x&quot;</span>\
             <span class=\"token-punctuation\">,</span> \
             <span class=\"token-literal\">null</span>\
             <span class=\"token-punctuation\">]</span>\
             <span class=\"token-punctuation\">}</span>"
        );
    }

    #[test]
    fn javascript_marks_keywords_calls_and_strings() {
        assert_eq!(
            highlight("import { x } from 'y'\nx()", "js"),
            "<span class=\"token-keyword\">import</span> \
             <span class=\"token-punctuation\">{</span> x \
             <span class=\"token-punctuation\">}</span> \
             <span class=\"token-keyword\">from</span> \
             <span class=\"token-string\">'y'</span>\n\
             <span class=\"token-function\">x</span>\
             <span class=\"token-punctuation\">(</span>\
             <span class=\"token-punctuation\">)</span>"
        );
    }

    #[test]
    fn an_open_string_runs_to_the_end() {
        assert_eq!(
            highlight("'abc", "sh"),
            "<span class=\"token-string\">'abc</span>"
        );
    }
}
