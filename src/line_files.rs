use crate::error::{Error, Result};
use crate::rle::{Cell, decode_value, parse_run};
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Read, Write};

pub const READ_BLOCK_BYTES: usize = 262_144;

pub const WRITE_BUFFER_BYTES: usize = 1_048_576;

pub struct LineReader {
    path: String,
    file: Option<File>,
    remaining: Option<u64>,
    pending: Vec<u8>,
    buffer: Vec<u8>,
}

impl LineReader {
    pub fn open(path: &str, max_bytes: Option<u64>) -> Result<LineReader> {
        let file = File::open(path).map_err(|error| Error::io(&error, path))?;
        Ok(LineReader {
            path: path.to_string(),
            file: Some(file),
            remaining: max_bytes,
            pending: Vec::new(),
            buffer: vec![0; READ_BLOCK_BYTES],
        })
    }

    pub fn read_block(&mut self) -> Result<Option<Vec<String>>> {
        loop {
            let Some(file) = self.file.as_mut() else {
                return Ok(None);
            };
            let limit = match self.remaining {
                Some(0) => 0,
                Some(left) => (left as usize).min(self.buffer.len()),
                None => self.buffer.len(),
            };
            let size = if limit == 0 {
                0
            } else {
                file.read(&mut self.buffer[..limit])
                    .map_err(|error| Error::io(&error, &self.path))?
            };
            if size == 0 {
                self.file = None;
                if self.remaining.is_some_and(|left| left > 0) {
                    return Err(Error::new(format!(
                        "{} is shorter than its commit",
                        self.path
                    )));
                }
                if !self.pending.is_empty() {
                    return Err(Error::new(format!(
                        "{} does not end with a line break",
                        self.path
                    )));
                }
                return Ok(None);
            }
            if let Some(left) = self.remaining.as_mut() {
                *left -= size as u64;
            }
            self.pending.extend_from_slice(&self.buffer[..size]);
            if let Some(last) = self.pending.iter().rposition(|byte| *byte == b'\n') {
                let rest = self.pending.split_off(last + 1);
                let complete = std::mem::replace(&mut self.pending, rest);
                let text = String::from_utf8_lossy(&complete[..complete.len() - 1]);
                return Ok(Some(text.split('\n').map(str::to_string).collect()));
            }
        }
    }
}

pub struct LineWriter {
    path: String,
    writer: Option<BufWriter<File>>,
}

impl LineWriter {
    pub fn create(path: &str) -> Result<LineWriter> {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(path)
            .map_err(|error| Error::io(&error, path))?;
        Ok(LineWriter {
            path: path.to_string(),
            writer: Some(BufWriter::with_capacity(WRITE_BUFFER_BYTES, file)),
        })
    }

    pub fn write(&mut self, text: &str) -> Result<()> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| Error::new(format!("{} is closed", self.path)))?;
        writer
            .write_all(text.as_bytes())
            .map_err(|error| Error::io(&error, &self.path))
    }

    pub fn close(mut self) -> Result<()> {
        let Some(writer) = self.writer.take() else {
            return Ok(());
        };
        let file = writer
            .into_inner()
            .map_err(|error| Error::io(error.error(), &self.path))?;
        file.sync_data()
            .map_err(|error| Error::io(&error, &self.path))
    }
}

pub fn write_synced_lines<'a>(path: &str, lines: impl IntoIterator<Item = &'a str>) -> Result<()> {
    let mut writer = LineWriter::create(path)?;
    for line in lines {
        writer.write(line)?;
    }
    writer.close()
}

pub trait ValueSource {
    fn take(&mut self, count: usize) -> Result<Vec<Cell>>;
    fn finish(&mut self) -> Result<()>;
}

pub struct NullValues;

impl ValueSource for NullValues {
    fn take(&mut self, count: usize) -> Result<Vec<Cell>> {
        Ok(vec![None; count])
    }

    fn finish(&mut self) -> Result<()> {
        Ok(())
    }
}

fn fewer_rows(path: &str) -> Error {
    Error::new(format!("{path} holds fewer rows than expected"))
}

fn more_rows(path: &str) -> Error {
    Error::new(format!("{path} holds more rows than expected"))
}

pub struct ValueReader {
    path: String,
    reader: LineReader,
    block: Vec<String>,
    index: usize,
}

impl ValueReader {
    pub fn open(path: &str, max_bytes: Option<u64>) -> Result<ValueReader> {
        Ok(ValueReader {
            path: path.to_string(),
            reader: LineReader::open(path, max_bytes)?,
            block: Vec::new(),
            index: 0,
        })
    }
}

impl ValueSource for ValueReader {
    fn take(&mut self, count: usize) -> Result<Vec<Cell>> {
        let mut values = Vec::with_capacity(count);
        while values.len() < count {
            if self.index == self.block.len() {
                match self.reader.read_block()? {
                    None => return Err(fewer_rows(&self.path)),
                    Some(block) => {
                        self.block = block;
                        self.index = 0;
                    }
                }
                continue;
            }
            let size = (count - values.len()).min(self.block.len() - self.index);
            for line in &self.block[self.index..self.index + size] {
                values.push(decode_value(line));
            }
            self.index += size;
        }
        Ok(values)
    }

    fn finish(&mut self) -> Result<()> {
        if self.index < self.block.len() || self.reader.read_block()?.is_some() {
            return Err(more_rows(&self.path));
        }
        Ok(())
    }
}

pub struct RunReader {
    path: String,
    reader: LineReader,
    block: Vec<String>,
    index: usize,
    value: Cell,
    left: u64,
}

impl RunReader {
    pub fn open(path: &str) -> Result<RunReader> {
        Ok(RunReader {
            path: path.to_string(),
            reader: LineReader::open(path, None)?,
            block: Vec::new(),
            index: 0,
            value: None,
            left: 0,
        })
    }

    fn next_run(&mut self) -> Result<()> {
        while self.index == self.block.len() {
            match self.reader.read_block()? {
                None => return Err(fewer_rows(&self.path)),
                Some(block) => {
                    self.block = block;
                    self.index = 0;
                }
            }
        }
        let line = &self.block[self.index];
        self.index += 1;
        let (count, value) = parse_run(line)?;
        self.value = decode_value(value);
        self.left = count;
        Ok(())
    }
}

impl ValueSource for RunReader {
    fn take(&mut self, count: usize) -> Result<Vec<Cell>> {
        let mut values = Vec::with_capacity(count);
        while values.len() < count {
            if self.left == 0 {
                self.next_run()?;
            }
            let size = ((count - values.len()) as u64).min(self.left);
            for _ in 0..size {
                values.push(self.value.clone());
            }
            self.left -= size;
        }
        Ok(values)
    }

    fn finish(&mut self) -> Result<()> {
        if self.left > 0 || self.index < self.block.len() || self.reader.read_block()?.is_some() {
            return Err(more_rows(&self.path));
        }
        Ok(())
    }
}
