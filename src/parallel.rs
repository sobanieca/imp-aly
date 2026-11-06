use crate::error::Result;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const SAMPLE: Duration = Duration::from_micros(300);

const WORTH_THREADS: Duration = Duration::from_millis(5);

pub fn default_threads() -> usize {
    std::thread::available_parallelism().map_or(1, std::num::NonZero::get)
}

pub fn in_order<T, R>(
    threads: usize,
    items: &[T],
    work: impl Fn(&T) -> R + Sync,
    mut apply: impl FnMut(usize, R) -> Result<()>,
) -> Result<()>
where
    T: Sync,
    R: Send,
{
    let started = Instant::now();
    let mut first = 0;
    while first < items.len() {
        let elapsed = started.elapsed();
        if threads > 1 && first > 0 && elapsed >= SAMPLE {
            let left = (items.len() - first) as u32;
            if elapsed / first as u32 * left > WORTH_THREADS {
                break;
            }
        }
        apply(first, work(&items[first]))?;
        first += 1;
    }
    let threads = threads.min(items.len() - first);
    if threads == 0 {
        return Ok(());
    }
    let next = AtomicUsize::new(first);
    let stop = AtomicBool::new(false);
    std::thread::scope(|scope| {
        let (sender, receiver) = mpsc::channel::<(usize, R)>();
        for _ in 0..threads {
            let sender = sender.clone();
            let (next, stop, work) = (&next, &stop, &work);
            scope.spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(item) = items.get(index) else {
                        return;
                    };
                    if sender.send((index, work(item))).is_err() {
                        return;
                    }
                }
            });
        }
        drop(sender);
        let mut waiting: BTreeMap<usize, R> = BTreeMap::new();
        let mut expected = first;
        for (index, result) in receiver {
            waiting.insert(index, result);
            while let Some(result) = waiting.remove(&expected) {
                if let Err(error) = apply(expected, result) {
                    stop.store(true, Ordering::Relaxed);
                    return Err(error);
                }
                expected += 1;
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::Error;

    #[test]
    fn results_arrive_in_the_order_of_the_items_and_an_error_stops_the_work() {
        let items: Vec<u64> = (0..200).collect();
        for threads in [1, 4] {
            let mut seen = Vec::new();
            in_order(
                threads,
                &items,
                |item| {
                    std::thread::sleep(std::time::Duration::from_micros((200 - item) * 5));
                    item * 2
                },
                |index, result| {
                    seen.push((index, result));
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(
                seen,
                items
                    .iter()
                    .map(|item| (*item as usize, item * 2))
                    .collect::<Vec<_>>()
            );
            let done = AtomicUsize::new(0);
            let error = in_order(
                threads,
                &items,
                |_| {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                    done.fetch_add(1, Ordering::Relaxed)
                },
                |index, _| {
                    if index == 10 {
                        return Err(Error::new("stop"));
                    }
                    Ok(())
                },
            )
            .unwrap_err();
            assert_eq!(error.message, "stop");
            assert!(done.load(Ordering::Relaxed) < items.len());
        }
    }
}
