//! How one file is cut into byte ranges and how idle connections take work.
//!
//! Pure bookkeeping, no I/O, so every rule here is unit tested. The engine in
//! `mod.rs` holds a `Plan` behind one mutex and asks it what to fetch next.
//!
//! The scheme is aria2's `--split`/`--min-split-size` plus work stealing: the
//! file starts as N equal ranges, and whenever a connection runs out of work
//! it takes the back half of whichever range has the most bytes left. A slow
//! connection therefore never leaves the download waiting on its tail, which
//! is where fixed splits lose most of their time.

use serde::{Deserialize, Serialize};

/// One byte range of the file. `end` is inclusive, `pos` is the next byte to
/// write; the range is finished once `pos > end`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub start: u64,
    pub end: u64,
    pub pos: u64,
}

impl Segment {
    pub fn new(start: u64, end: u64) -> Self {
        Segment { start, end, pos: start }
    }

    pub fn remaining(&self) -> u64 {
        if self.pos > self.end {
            0
        } else {
            self.end - self.pos + 1
        }
    }

    pub fn is_done(&self) -> bool {
        self.pos > self.end
    }

    /// Bytes of this range already on disk, never past its own end, so a
    /// range shortened by a steal does not count the stolen half twice.
    pub fn written(&self) -> u64 {
        self.pos.min(self.end + 1) - self.start
    }
}

/// Every range of one file and which of them a connection is working on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub total: u64,
    pub segments: Vec<Segment>,
    owned: Vec<bool>,
}

impl Plan {
    /// Cuts `total` bytes into at most `connections` equal ranges, none
    /// smaller than `min_split` (except a file smaller than that, which is
    /// one range).
    pub fn new(total: u64, connections: u32, min_split: u64) -> Self {
        if total == 0 {
            return Plan { total, segments: Vec::new(), owned: Vec::new() };
        }
        let by_size = (total / min_split.max(1)).max(1);
        let count = by_size.min(u64::from(connections.max(1)));
        let size = total / count;
        let segments: Vec<Segment> = (0..count)
            .map(|i| {
                let start = i * size;
                let end = if i == count - 1 { total - 1 } else { start + size - 1 };
                Segment::new(start, end)
            })
            .collect();
        let owned = vec![false; segments.len()];
        Plan { total, segments, owned }
    }

    /// A plan loaded from a resume file, only if it still describes the whole
    /// file exactly; nothing is owned yet.
    pub fn restored(total: u64, segments: Vec<Segment>) -> Option<Self> {
        let covered: u64 = segments.iter().map(|s| s.end + 1 - s.start).sum();
        let ordered = segments.windows(2).all(|w| w[0].end + 1 == w[1].start);
        let valid = total > 0
            && covered == total
            && ordered
            && segments.first().map(|s| s.start) == Some(0)
            && segments.iter().all(|s| s.start <= s.end && s.pos >= s.start);
        if !valid {
            return None;
        }
        let owned = vec![false; segments.len()];
        Some(Plan { total, segments, owned })
    }

    /// Hands a connection its next range: an unclaimed one first, otherwise
    /// the back half of the busiest range, as long as both halves stay at
    /// least `min_split` long. `None` means nothing is left worth splitting
    /// and the connection can retire.
    pub fn claim(&mut self, min_split: u64) -> Option<usize> {
        if let Some(i) =
            (0..self.segments.len()).find(|&i| !self.owned[i] && !self.segments[i].is_done())
        {
            self.owned[i] = true;
            return Some(i);
        }

        let (victim, remaining) = self
            .segments
            .iter()
            .enumerate()
            .filter(|(i, _)| self.owned[*i])
            .map(|(i, s)| (i, s.remaining()))
            .max_by_key(|(_, r)| *r)?;
        if remaining < min_split.max(1) * 2 {
            return None;
        }

        let old = &mut self.segments[victim];
        let mid = old.pos + remaining / 2;
        let stolen = Segment::new(mid, old.end);
        old.end = mid - 1;
        // Kept in file order so the piece map and the resume file read left
        // to right. Indices after `victim` shift by one; the engine re-reads
        // its window by index on every chunk, see `index_of`.
        let at = victim + 1;
        self.segments.insert(at, stolen);
        self.owned.insert(at, true);
        Some(at)
    }

    /// The current index of the range that starts at `start`. Ranges never
    /// change their start, so it is the stable name a connection holds while
    /// steals insert ranges ahead of it.
    pub fn index_of(&self, start: u64) -> Option<usize> {
        self.segments.binary_search_by_key(&start, |s| s.start).ok()
    }

    /// Gives a range back, finished or not, so another connection may take it.
    pub fn release(&mut self, index: usize) {
        if let Some(flag) = self.owned.get_mut(index) {
            *flag = false;
        }
    }

    /// Records `len` bytes written at `at` inside range `index`, and returns
    /// how many of them belong to it (a steal may have shortened it since).
    pub fn advance(&mut self, index: usize, at: u64, len: u64) -> u64 {
        let Some(seg) = self.segments.get_mut(index) else {
            return 0;
        };
        if at != seg.pos || seg.is_done() {
            return 0;
        }
        let usable = len.min(seg.remaining());
        seg.pos += usable;
        usable
    }

    /// Where range `index` resumes and where it ends now.
    pub fn window(&self, index: usize) -> Option<(u64, u64)> {
        self.segments.get(index).map(|s| (s.pos, s.end))
    }

    pub fn written(&self) -> u64 {
        self.segments.iter().map(Segment::written).sum()
    }

    pub fn is_complete(&self) -> bool {
        self.segments.iter().all(Segment::is_done)
    }

    pub fn active(&self) -> u32 {
        self.segments
            .iter()
            .zip(&self.owned)
            .filter(|(s, owned)| **owned && !s.is_done())
            .count() as u32
    }

    /// The file as `cells` buckets, each 0-100 percent written: the piece map
    /// the interface draws.
    pub fn piece_map(&self, cells: usize) -> Vec<u8> {
        if self.total == 0 || cells == 0 {
            return Vec::new();
        }
        let cells = cells.min(self.total as usize).max(1) as u64;
        let bounds = |c: u64| (self.total * c / cells, self.total * (c + 1) / cells);
        let mut done = vec![0u64; cells as usize];
        for seg in &self.segments {
            let (from, to) = (seg.start, seg.pos.min(seg.end + 1));
            if from >= to {
                continue;
            }
            let first = from * cells / self.total;
            let last = ((to - 1) * cells / self.total).min(cells - 1);
            for c in first..=last {
                let (a, b) = bounds(c);
                done[c as usize] += to.min(b).saturating_sub(from.max(a));
            }
        }
        done.iter()
            .enumerate()
            .map(|(c, bytes)| {
                let (a, b) = bounds(c as u64);
                ((bytes * 100) / (b - a).max(1)).min(100) as u8
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    fn covers_whole_file(plan: &Plan) {
        assert_eq!(plan.segments.first().unwrap().start, 0);
        assert_eq!(plan.segments.last().unwrap().end, plan.total - 1);
        for w in plan.segments.windows(2) {
            assert_eq!(w[0].end + 1, w[1].start, "gap or overlap in {:?}", plan.segments);
        }
    }

    #[test]
    fn splits_a_large_file_into_one_range_per_connection() {
        let plan = Plan::new(100 * MIB, 16, MIB);
        assert_eq!(plan.segments.len(), 16);
        covers_whole_file(&plan);
    }

    #[test]
    fn never_makes_ranges_smaller_than_the_minimum_split() {
        let plan = Plan::new(3 * MIB + 5, 16, MIB);
        assert_eq!(plan.segments.len(), 3);
        covers_whole_file(&plan);
    }

    #[test]
    fn a_tiny_file_is_one_range() {
        let plan = Plan::new(10, 16, MIB);
        assert_eq!(plan.segments, vec![Segment::new(0, 9)]);
    }

    #[test]
    fn an_empty_file_has_nothing_to_fetch() {
        let mut plan = Plan::new(0, 16, MIB);
        assert!(plan.is_complete());
        assert_eq!(plan.claim(MIB), None);
    }

    #[test]
    fn claims_unowned_ranges_before_stealing() {
        let mut plan = Plan::new(4 * MIB, 4, MIB);
        let claimed: Vec<_> = (0..4).map(|_| plan.claim(MIB).unwrap()).collect();
        assert_eq!(claimed, vec![0, 1, 2, 3]);
        assert_eq!(plan.segments.len(), 4);
    }

    #[test]
    fn an_idle_connection_steals_the_back_half_of_the_busiest_range() {
        let mut plan = Plan::new(8 * MIB, 2, MIB);
        let a = plan.claim(MIB).unwrap();
        let b = plan.claim(MIB).unwrap();
        // Range b races ahead and finishes; range a has barely started.
        let (pos, end) = plan.window(b).unwrap();
        plan.advance(b, pos, end - pos + 1);
        plan.release(b);
        plan.advance(a, 0, MIB);

        let stolen = plan.claim(MIB).expect("busy range should be split");
        covers_whole_file(&plan);
        let left = &plan.segments[a];
        let right = &plan.segments[stolen];
        assert_eq!(left.end + 1, right.start);
        assert_eq!(left.remaining(), 3 * MIB / 2);
        assert_eq!(right.remaining(), 3 * MIB / 2);
        assert_eq!(plan.written(), 5 * MIB);
        assert_eq!(plan.index_of(right.start), Some(stolen));
    }

    #[test]
    fn stops_stealing_when_halves_would_drop_below_the_minimum() {
        let mut plan = Plan::new(3 * MIB, 1, MIB);
        let a = plan.claim(MIB).unwrap();
        plan.advance(a, 0, 3 * MIB / 2);
        assert_eq!(plan.claim(MIB), None);
    }

    #[test]
    fn writes_past_a_shortened_range_are_clamped_and_counted_once() {
        let mut plan = Plan::new(4 * MIB, 1, MIB);
        let a = plan.claim(MIB).unwrap();
        let b = plan.claim(MIB).unwrap();
        // The first connection read a chunk sized for the old end; only the
        // bytes up to the new end belong to it.
        let used = plan.advance(a, 0, 3 * MIB);
        assert_eq!(used, 2 * MIB);
        assert!(plan.segments[a].is_done());
        assert_eq!(plan.window(b), Some((2 * MIB, 4 * MIB - 1)));
        assert_eq!(plan.written(), 2 * MIB);
    }

    #[test]
    fn ignores_a_write_that_does_not_continue_the_range() {
        let mut plan = Plan::new(2 * MIB, 1, MIB);
        let a = plan.claim(MIB).unwrap();
        assert_eq!(plan.advance(a, 512, 10), 0);
        assert_eq!(plan.written(), 0);
    }

    #[test]
    fn restores_only_a_plan_that_covers_the_file_exactly() {
        let good = vec![
            Segment { start: 0, end: 9, pos: 4 },
            Segment { start: 10, end: 19, pos: 20 },
        ];
        let plan = Plan::restored(20, good.clone()).unwrap();
        assert_eq!(plan.written(), 14);
        assert!(Plan::restored(21, good).is_none());
        let gap = vec![Segment::new(0, 8), Segment::new(10, 19)];
        assert!(Plan::restored(20, gap).is_none());
    }

    #[test]
    fn piece_map_reports_each_cell_as_a_percentage() {
        let mut plan = Plan::new(400, 4, 100);
        let first = plan.claim(100).unwrap();
        plan.advance(first, 0, 100);
        let second = plan.claim(100).unwrap();
        plan.advance(second, 100, 50);
        assert_eq!(plan.piece_map(4), vec![100, 50, 0, 0]);
        assert_eq!(plan.piece_map(2), vec![75, 0]);
    }
}
