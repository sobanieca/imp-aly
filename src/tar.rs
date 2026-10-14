use std::io::{self, Read, Write};

pub const BLOCK_BYTES: usize = 512;

const NAME_BYTES: usize = 100;

const PREFIX_BYTES: usize = 155;

fn octal(value: u64, width: usize) -> String {
    format!("{value:0>pad$o}\0", pad = width - 1)
}

fn split_name(name: &str) -> Result<(&[u8], &[u8]), String> {
    let bytes = name.as_bytes();
    if bytes.len() <= NAME_BYTES {
        return Ok((&[], bytes));
    }
    let limit = PREFIX_BYTES.min(bytes.len() - 1);
    let slash = bytes[..=limit].iter().rposition(|byte| *byte == b'/');
    match slash {
        Some(at) if at > 0 && at != bytes.len() - 1 && bytes.len() - at - 1 <= NAME_BYTES => {
            Ok((&bytes[..at], &bytes[at + 1..]))
        }
        _ => Err(format!("the archive name {name} is too long")),
    }
}

fn put(block: &mut [u8], offset: usize, text: &[u8]) {
    block[offset..offset + text.len()].copy_from_slice(text);
}

pub fn tar_header(name: &str, size: u64, mtime_ms: i64) -> Result<[u8; BLOCK_BYTES], String> {
    let (prefix, last) = split_name(name)?;
    let mut block = [0u8; BLOCK_BYTES];
    put(&mut block, 0, last);
    put(&mut block, 345, prefix);
    put(&mut block, 100, octal(0o644, 8).as_bytes());
    put(&mut block, 108, octal(0, 8).as_bytes());
    put(&mut block, 116, octal(0, 8).as_bytes());
    put(&mut block, 124, octal(size, 12).as_bytes());
    put(
        &mut block,
        136,
        octal((mtime_ms / 1000).max(0) as u64, 12).as_bytes(),
    );
    put(&mut block, 148, b"        ");
    put(&mut block, 156, b"0");
    put(&mut block, 257, b"ustar\0");
    put(&mut block, 263, b"00");
    let sum: u64 = block.iter().map(|byte| u64::from(*byte)).sum();
    put(&mut block, 148, format!("{sum:06o}\0 ").as_bytes());
    Ok(block)
}

pub fn padding(size: usize) -> usize {
    (BLOCK_BYTES - size % BLOCK_BYTES) % BLOCK_BYTES
}

pub fn write_entry(out: &mut impl Write, name: &str, data: &[u8], mtime_ms: i64) -> io::Result<()> {
    let header = tar_header(name, data.len() as u64, mtime_ms).map_err(io::Error::other)?;
    out.write_all(&header)?;
    out.write_all(data)?;
    out.write_all(&vec![0u8; padding(data.len())])
}

pub fn write_end(out: &mut impl Write) -> io::Result<()> {
    out.write_all(&[0u8; BLOCK_BYTES * 2])
}

fn field(block: &[u8], offset: usize, length: usize) -> String {
    let bytes = &block[offset..offset + length];
    let end = bytes
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn read_octal(block: &[u8], offset: usize, length: usize) -> Result<u64, String> {
    let text = field(block, offset, length);
    let text = text.trim();
    if text.is_empty() || text.len() > 22 || !text.bytes().all(|byte| (b'0'..=b'7').contains(&byte))
    {
        return Err("the archive has a header that is not valid".to_string());
    }
    u64::from_str_radix(text, 8)
        .map_err(|_| "the archive has a header that is not valid".to_string())
}

fn check_header(block: &[u8]) -> Result<(), String> {
    let stored = read_octal(block, 148, 8)?;
    let sum: u64 = block
        .iter()
        .enumerate()
        .map(|(index, byte)| {
            if (148..156).contains(&index) {
                32
            } else {
                u64::from(*byte)
            }
        })
        .sum();
    if sum != stored {
        return Err("the archive has a header with a wrong checksum".to_string());
    }
    Ok(())
}

pub struct TarReader<R: Read> {
    input: R,
    max_entry_bytes: u64,
    done: bool,
}

fn read_full(input: &mut impl Read, buffer: &mut [u8]) -> Result<usize, String> {
    let mut filled = 0;
    while filled < buffer.len() {
        match input.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(size) => filled += size,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(filled)
}

impl<R: Read> TarReader<R> {
    pub fn new(input: R, max_entry_bytes: u64) -> Self {
        TarReader {
            input,
            max_entry_bytes,
            done: false,
        }
    }

    pub fn next_entry(&mut self) -> Result<Option<(String, Vec<u8>)>, String> {
        loop {
            if self.done {
                return Ok(None);
            }
            let mut block = [0u8; BLOCK_BYTES];
            let read = read_full(&mut self.input, &mut block)?;
            if read == 0 || (read == BLOCK_BYTES && block.iter().all(|byte| *byte == 0)) {
                self.done = true;
                return Ok(None);
            }
            if read < BLOCK_BYTES {
                return Err("the archive ends in the middle of a file".to_string());
            }
            check_header(&block)?;
            let kind = block[156];
            let size = read_octal(&block, 124, 12)?;
            let prefix = if field(&block, 257, 6) == "ustar" {
                field(&block, 345, PREFIX_BYTES)
            } else {
                String::new()
            };
            let base = field(&block, 0, NAME_BYTES);
            let name = if prefix.is_empty() {
                base
            } else {
                format!("{prefix}/{base}")
            };
            if size > self.max_entry_bytes {
                return Err(format!(
                    "the archive entry {name} is larger than {} bytes",
                    self.max_entry_bytes
                ));
            }
            let mut data = vec![0u8; size as usize];
            if read_full(&mut self.input, &mut data)? < data.len() {
                return Err("the archive ends in the middle of a file".to_string());
            }
            let mut pad = vec![0u8; padding(size as usize)];
            if read_full(&mut self.input, &mut pad)? < pad.len() {
                return Err("the archive ends in the middle of a file".to_string());
            }
            if kind == b'0' || kind == 0 {
                let mut clean = name.as_str();
                while let Some(rest) = clean.strip_prefix("./") {
                    clean = rest;
                }
                return Ok(Some((clean.to_string(), data)));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        for (name, data) in entries {
            write_entry(&mut out, name, data, 1_700_000_000_000).unwrap();
        }
        write_end(&mut out).unwrap();
        out
    }

    fn read_all(bytes: &[u8], max: u64) -> Result<Vec<(String, Vec<u8>)>, String> {
        let mut reader = TarReader::new(bytes, max);
        let mut out = Vec::new();
        while let Some(entry) = reader.next_entry()? {
            out.push(entry);
        }
        Ok(out)
    }

    #[test]
    fn an_archive_round_trips() {
        let bytes = archive(&[("a/b.txt", b"hello"), ("c.txt", &[7u8; 1000])]);
        assert_eq!(bytes.len() % BLOCK_BYTES, 0);
        let entries = read_all(&bytes, 10_000).unwrap();
        assert_eq!(entries[0], ("a/b.txt".to_string(), b"hello".to_vec()));
        assert_eq!(entries[1].1.len(), 1000);
    }

    #[test]
    fn a_damaged_cut_or_too_large_archive_fails() {
        let mut bytes = archive(&[("a.txt", b"hello")]);
        assert!(read_all(&bytes, 3).unwrap_err().contains("larger than"));
        assert!(read_all(&bytes[..600], 100).unwrap_err().contains("middle"));
        bytes[0] = b'b';
        assert!(read_all(&bytes, 100).unwrap_err().contains("checksum"));
    }

    #[test]
    fn a_long_name_goes_into_the_prefix_field_and_reads_back_whole() {
        let name = format!("{}/{}/summary-counts.tsv", "a".repeat(60), "b".repeat(60));
        let bytes = archive(&[(&name, b"x")]);
        assert_eq!(read_all(&bytes, 10).unwrap()[0].0, name);
        assert!(tar_header(&"x".repeat(300), 1, 0).is_err());
    }

    #[test]
    fn folders_are_skipped_and_a_leading_dot_slash_is_removed() {
        let mut out = Vec::new();
        let mut folder = tar_header("./dir/", 0, 0).unwrap();
        folder[156] = b'5';
        folder[148..156].copy_from_slice(b"        ");
        let sum: u64 = folder.iter().map(|byte| u64::from(*byte)).sum();
        folder[148..156].copy_from_slice(format!("{sum:06o}\0 ").as_bytes());
        out.extend_from_slice(&folder);
        write_entry(&mut out, "./dir/a.txt", b"a", 0).unwrap();
        write_end(&mut out).unwrap();
        let entries = read_all(&out, 10).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0, "dir/a.txt");
    }
}
