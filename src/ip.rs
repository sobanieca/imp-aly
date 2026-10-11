#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ip {
    V4([u16; 4]),
    V6([u16; 8]),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Network {
    pub ip: Ip,
    pub bits: u32,
}

fn parse_ipv4(text: &str) -> Option<[u16; 4]> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u16; 4];
    for (at, part) in parts.iter().enumerate() {
        if part.is_empty() || part.len() > 3 || !part.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        let value: u16 = part.parse().ok()?;
        if value > 255 {
            return None;
        }
        out[at] = value;
    }
    Some(out)
}

fn push_groups(groups: &mut Vec<u16>, part: &str, last: bool) -> bool {
    if part.is_empty() {
        return true;
    }
    let items: Vec<&str> = part.split(':').collect();
    for (at, item) in items.iter().enumerate() {
        if last && at == items.len() - 1 && item.contains('.') {
            let Some(bytes) = parse_ipv4(item) else {
                return false;
            };
            groups.push((bytes[0] << 8) | bytes[1]);
            groups.push((bytes[2] << 8) | bytes[3]);
        } else if !item.is_empty()
            && item.len() <= 4
            && item.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            groups.push(u16::from_str_radix(item, 16).unwrap_or(0));
        } else {
            return false;
        }
    }
    true
}

fn parse_ipv6(text: &str) -> Option<[u16; 8]> {
    let gap = text.find("::");
    if let Some(at) = gap
        && text[at + 1..].contains("::")
    {
        return None;
    }
    let mut left = Vec::new();
    let mut right = Vec::new();
    let head = gap.map_or(text, |at| &text[..at]);
    if !push_groups(&mut left, head, gap.is_none()) {
        return None;
    }
    if let Some(at) = gap
        && !push_groups(&mut right, &text[at + 2..], true)
    {
        return None;
    }
    let used = left.len() + right.len();
    if gap.is_none() && used != 8 || gap.is_some() && used > 7 {
        return None;
    }
    while left.len() + right.len() < 8 {
        left.push(0);
    }
    left.extend(right);
    let mut out = [0u16; 8];
    out.copy_from_slice(&left);
    Some(out)
}

pub fn parse_ip(text: &str) -> Option<Ip> {
    let mut plain = text.trim();
    if plain.starts_with('[') && plain.ends_with(']') && plain.len() >= 2 {
        plain = &plain[1..plain.len() - 1];
    }
    if let Some(at) = plain.find('%') {
        plain = &plain[..at];
    }
    if !plain.contains(':') {
        return parse_ipv4(plain).map(Ip::V4);
    }
    let groups = parse_ipv6(plain)?;
    if groups[..5].iter().all(|group| *group == 0) && groups[5] == 0xffff {
        return Some(Ip::V4([
            groups[6] >> 8,
            groups[6] & 255,
            groups[7] >> 8,
            groups[7] & 255,
        ]));
    }
    Some(Ip::V6(groups))
}

pub fn parse_client_address(text: &str) -> Option<Ip> {
    let plain = text.trim();
    if let Some(rest) = plain.strip_prefix('[')
        && let Some(close) = rest.find(']')
    {
        let inner = &rest[..close];
        let after = &rest[close + 1..];
        let port_ok = after.is_empty()
            || after.strip_prefix(':').is_some_and(|digits| {
                !digits.is_empty()
                    && digits.len() <= 5
                    && digits.bytes().all(|byte| byte.is_ascii_digit())
            });
        if port_ok {
            return if inner.contains(':') {
                parse_ip(inner)
            } else {
                None
            };
        }
    }
    if let Some((host, port)) = plain.rsplit_once(':')
        && !host.is_empty()
        && host
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.')
        && !port.is_empty()
        && port.len() <= 5
        && port.bytes().all(|byte| byte.is_ascii_digit())
    {
        return parse_ip(host);
    }
    parse_ip(plain)
}

pub fn format_ip(ip: &Ip) -> String {
    match ip {
        Ip::V4(parts) => parts
            .iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join("."),
        Ip::V6(parts) => parts
            .iter()
            .map(|part| format!("{part:x}"))
            .collect::<Vec<_>>()
            .join(":"),
    }
}

fn part_bits(ip: &Ip) -> u32 {
    match ip {
        Ip::V4(_) => 8,
        Ip::V6(_) => 16,
    }
}

fn parts(ip: &Ip) -> &[u16] {
    match ip {
        Ip::V4(parts) => parts,
        Ip::V6(parts) => parts,
    }
}

pub fn parse_network(text: &str) -> Result<Network, String> {
    let pieces: Vec<&str> = text.trim().split('/').collect();
    let ip = if pieces.len() > 2 {
        None
    } else {
        parse_ip(pieces[0])
    };
    let Some(ip) = ip else {
        return Err(format!("\"{text}\" is not an address or a network"));
    };
    let max = parts(&ip).len() as u32 * part_bits(&ip);
    let bits = match pieces.get(1) {
        None => max,
        Some(length) => {
            if length.is_empty()
                || length.len() > 3
                || !length.bytes().all(|byte| byte.is_ascii_digit())
            {
                return Err(format!("\"{text}\" has a wrong prefix length"));
            }
            length.parse::<u32>().unwrap_or(u32::MAX)
        }
    };
    if bits > max {
        return Err(format!("\"{text}\" has a wrong prefix length"));
    }
    Ok(Network { ip, bits })
}

pub fn in_network(ip: Option<&Ip>, network: &Network) -> bool {
    let Some(ip) = ip else {
        return false;
    };
    if std::mem::discriminant(ip) != std::mem::discriminant(&network.ip) {
        return false;
    }
    let size = part_bits(ip);
    let mut bit = 0;
    while bit < network.bits {
        let index = (bit / size) as usize;
        let shift = size.saturating_sub(network.bits - bit);
        if (parts(ip)[index] >> shift) != (parts(&network.ip)[index] >> shift) {
            return false;
        }
        bit += size;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ipv4_and_ipv6_addresses() {
        assert_eq!(parse_ip("203.0.113.9"), Some(Ip::V4([203, 0, 113, 9])));
        assert_eq!(parse_ip("256.0.0.1"), None);
        assert_eq!(
            format_ip(&parse_ip("2001:db8::1").unwrap()),
            "2001:db8:0:0:0:0:0:1"
        );
        assert_eq!(parse_ip("::ffff:10.1.2.3"), Some(Ip::V4([10, 1, 2, 3])));
        assert_eq!(parse_ip("fe80::1%eth0"), parse_ip("fe80::1"));
        assert_eq!(parse_ip("1::2::3"), None);
        assert_eq!(parse_ip("1:2:3:4:5:6:7:8:9"), None);
        assert_eq!(parse_ip("nope"), None);
    }

    #[test]
    fn matches_addresses_to_networks() {
        let network = parse_network("10.0.0.0/8").unwrap();
        assert!(in_network(parse_ip("10.200.1.1").as_ref(), &network));
        assert!(!in_network(parse_ip("11.0.0.1").as_ref(), &network));
        let v6 = parse_network("2001:db8::/32").unwrap();
        assert!(in_network(parse_ip("2001:db8:ffff::1").as_ref(), &v6));
        assert!(!in_network(parse_ip("2001:db9::1").as_ref(), &v6));
        let odd = parse_network("192.168.0.0/23").unwrap();
        assert!(in_network(parse_ip("192.168.1.200").as_ref(), &odd));
        assert!(!in_network(parse_ip("192.168.2.1").as_ref(), &odd));
        assert!(in_network(
            parse_ip("::1").as_ref(),
            &parse_network("::1").unwrap()
        ));
    }

    #[test]
    fn refuses_a_wrong_network() {
        assert!(parse_network("10.0.0.0/33").is_err());
        assert!(parse_network("10.0.0.0/x").is_err());
        assert!(parse_network("nope/8").is_err());
        assert!(parse_network("10.0.0.0/8/1").is_err());
    }

    #[test]
    fn parses_a_client_address_with_a_port_in_brackets_or_bare() {
        assert_eq!(
            parse_client_address("203.0.113.9:443"),
            parse_ip("203.0.113.9")
        );
        assert_eq!(
            parse_client_address("[2001:db8::1]:443"),
            parse_ip("2001:db8::1")
        );
        assert_eq!(
            parse_client_address("[2001:db8::1]"),
            parse_ip("2001:db8::1")
        );
        assert_eq!(
            parse_client_address(" 2001:db8::1 "),
            parse_ip("2001:db8::1")
        );
        assert_eq!(parse_client_address("[1.2.3.4]"), None);
        assert_eq!(parse_client_address("unknown"), None);
    }
}
