//! 総当たり。小さなグラフで、`dp.rs` の答えを確かめるためだけに使います。
//!
//! 経路を1歩ずつ伸ばしていく、いちばん素直な書きかたです。`dp.rs` は経路を
//! 「辺の集まり」として扱うので、考えかたがまったく違います。2つの答えが
//! いつも合うことを、乱数で作ったグラフで確かめます（tests/）。
//! 駅が20を超えると終わりません。

use crate::Problem;

struct Ctx<'a> {
    p: &'a Problem,
    adj: Vec<Vec<u32>>,
    visited: Vec<bool>,
    used: Vec<bool>,
    best: i64,
}

impl Ctx<'_> {
    fn blocked(&self, x: u32, a: Option<u32>, b: u32) -> bool {
        let Some(a) = a else { return false };
        self.p.forbid.iter().any(|&(fx, fa, fb)| fx == x && ((fa == a && fb == b) || (fa == b && fb == a)))
    }
    fn go(&mut self, head: u32, prev: Option<u32>, total: i64) {
        self.best = self.best.max(total);
        for i in 0..self.adj[head as usize].len() {
            let e = self.adj[head as usize][i];
            if self.used[e as usize] || self.blocked(head, prev, e) {
                continue;
            }
            let ed = self.p.edges[e as usize].clone();
            let to = if ed.u == head { ed.v } else { ed.u };
            let stub = if to == ed.u { ed.stub_u } else { ed.stub_v };
            if stub > 0 {
                self.best = self.best.max(total + stub);
            }
            if self.visited[to as usize] {
                if self.p.allow_loop {
                    self.best = self.best.max(total + ed.w);
                }
                continue;
            }
            self.used[e as usize] = true;
            self.visited[to as usize] = true;
            self.go(to, Some(e), total + ed.w);
            self.visited[to as usize] = false;
            self.used[e as usize] = false;
        }
    }
}

pub fn longest(p: &Problem) -> i64 {
    let mut adj = vec![Vec::new(); p.n];
    for (i, e) in p.edges.iter().enumerate() {
        adj[e.u as usize].push(i as u32);
        adj[e.v as usize].push(i as u32);
    }
    let mut c = Ctx { p, adj, visited: vec![false; p.n], used: vec![false; p.edges.len()], best: 0 };
    let starts: Vec<u32> = match p.start {
        Some(s) => vec![s],
        None => (0..p.n as u32).collect(),
    };
    for s in starts {
        c.visited[s as usize] = true;
        c.go(s, None, 0);
        c.visited[s as usize] = false;
    }
    if p.start.is_none() {
        // となりの駅から出る形。
        for (i, e) in p.edges.iter().enumerate() {
            for (w, to) in [(e.stub_u, e.v), (e.stub_v, e.u)] {
                if w <= 0 {
                    continue;
                }
                c.used[i] = true;
                c.visited[to as usize] = true;
                c.go(to, Some(i as u32), w);
                c.visited[to as usize] = false;
                c.used[i] = false;
            }
        }
    }
    c.best
}
