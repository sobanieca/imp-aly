use std::net::IpAddr;

fn is_link_local(address: &str) -> bool {
    address.starts_with("fe80:") || address.starts_with("169.254.")
}

fn is_loopback(address: &str) -> bool {
    address == "::1" || address.starts_with("127.")
}

fn is_private_v4(address: &str) -> bool {
    if address.starts_with("10.") || address.starts_with("192.168.") {
        return true;
    }
    address
        .strip_prefix("172.")
        .and_then(|rest| rest.split('.').next())
        .and_then(|second| second.parse::<u8>().ok())
        .is_some_and(|second| (16..=31).contains(&second))
}

fn interface_addresses() -> Vec<IpAddr> {
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cursor = list;
    while !cursor.is_null() {
        let entry = unsafe { &*cursor };
        if !entry.ifa_addr.is_null() {
            let family = i32::from(unsafe { (*entry.ifa_addr).sa_family });
            if family == libc::AF_INET {
                let address = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in) };
                out.push(IpAddr::from(
                    u32::from_be(address.sin_addr.s_addr).to_be_bytes(),
                ));
            } else if family == libc::AF_INET6 {
                let address = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in6) };
                out.push(IpAddr::from(address.sin6_addr.s6_addr));
            }
        }
        cursor = entry.ifa_next;
    }
    unsafe { libc::freeifaddrs(list) };
    out
}

pub fn local_addresses() -> Vec<String> {
    let mut all: Vec<String> = Vec::new();
    for address in interface_addresses() {
        let text = address.to_string();
        if is_loopback(&text) || is_link_local(&text) || all.contains(&text) {
            continue;
        }
        all.push(text);
    }
    let score = |address: &String| {
        if address.contains(':') {
            2
        } else if is_private_v4(address) {
            1
        } else {
            0
        }
    };
    all.sort_by_key(score);
    all
}

pub fn format_host(address: &str) -> String {
    if address.contains(':') {
        format!("[{address}]")
    } else {
        address.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_public_addresses_first() {
        for address in local_addresses() {
            assert!(!is_loopback(&address));
        }
        assert!(is_private_v4("172.20.1.1"));
        assert!(!is_private_v4("172.40.1.1"));
        assert_eq!(format_host("::1"), "[::1]");
    }
}
