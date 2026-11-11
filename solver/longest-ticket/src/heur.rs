//! 手早い探索。暫定の経路を作ります。
//!
//! `dp.rs` は、暫定の経路に届かない枝を捨てます。暫定が長いほど、捨てられる枝が
//! 増えます。ここでは、決まった回数だけ深さ優先で進んでは戻る探索を、出発点と
//! 進む順を変えながら繰り返します。**最適かどうかは、ここでは分かりません。**
//! 制限時間に当たって `dp.rs` が終わらなかったときは、これが答えになります。

use crate::{Clock, Leg, Problem};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

struct Ctx<'a> {
    p: &'a Problem,
    adj: Vec<Vec<u32>>,
    forbid: Vec<Option<(u32, u32)>>,
    visited: Vec<bool>,
    used: Vec<bool>,
    path: Vec<Leg>,
    best: i64,
    best_route: Vec<Leg>,
    budget: u64,
    rng: Rng,
}

impl Ctx<'_> {
    fn blocked(&self, x: u32, a: Option<u32>, b: u32) -> bool {
        match (self.forbid[x as usize], a) {
            (Some((fa, fb)), Some(a)) => (fa == a && fb == b) || (fa == b && fb == a),
            _ => false,
        }
    }
    fn offer(&mut self, total: i64, last: Option<Leg>) {
        if total > self.best {
            self.best = total;
            self.best_route = self.path.clone();
            if let Some(l) = last {
                self.best_route.push(l);
            }
        }
    }
    fn go(&mut self, head: u32, prev: Option<u32>, total: i64) {
        self.offer(total, None);
        if self.budget == 0 {
            return;
        }
        self.budget -= 1;
        let mut next: Vec<u32> = self.adj[head as usize]
            .iter()
            .copied()
            .filter(|&e| !self.used[e as usize] && !self.blocked(head, prev, e))
            .collect();
        // 長い辺を先に。ときどき順を崩します。
        next.sort_by_key(|&e| -self.p.edges[e as usize].w);
        if next.len() > 1 && self.rng.below(3) == 0 {
            let i = self.rng.below(next.len());
            next.swap(0, i);
        }
        for e in next {
            let ed = &self.p.edges[e as usize];
            let to = if ed.u == head { ed.v } else { ed.u };
            let stub = if to == ed.u { ed.stub_u } else { ed.stub_v };
            if stub > 0 {
                self.offer(total + stub, Some(Leg { edge: e, from: head, to, mode: 2 }));
            }
            let leg = Leg { edge: e, from: head, to, mode: 0 };
            if self.visited[to as usize] {
                if self.p.allow_loop {
                    self.offer(total + ed.w, Some(leg));
                }
                continue;
            }
            self.used[e as usize] = true;
            self.visited[to as usize] = true;
            self.path.push(leg);
            self.go(to, Some(e), total + ed.w);
            self.path.pop();
            self.visited[to as usize] = false;
            self.used[e as usize] = false;
        }
    }
}

pub fn search(p: &Problem, clock: &Clock, budget_ms: u64) -> (i64, Vec<Leg>) {
    let mut adj = vec![Vec::new(); p.n];
    for (i, e) in p.edges.iter().enumerate() {
        adj[e.u as usize].push(i as u32);
        adj[e.v as usize].push(i as u32);
    }
    let mut forbid = vec![None; p.n];
    for &(x, a, b) in &p.forbid {
        forbid[x as usize] = Some((a, b));
    }
    let mut c = Ctx {
        p,
        adj,
        forbid,
        visited: vec![false; p.n],
        used: vec![false; p.edges.len()],
        path: Vec::new(),
        best: 0,
        best_route: Vec::new(),
        budget: 0,
        rng: Rng(0x9e37_79b9_7f4a_7c15),
    };
    let t0 = clock.ms();
    // 出発点の候補: 行き止まりの駅を先に（端から出るほうが長くなりやすい）。
    let mut starts: Vec<u32> = (0..p.n as u32).filter(|&x| !c.adj[x as usize].is_empty()).collect();
    starts.sort_by_key(|&x| c.adj[x as usize].len());
    let mut round = 0usize;
    loop {
        let start = match p.start {
            Some(s) => s,
            None => {
                if starts.is_empty() {
                    break;
                }
                starts[round % starts.len()]
            }
        };
        c.budget = 4000;
        // 3回に1回は、となりの駅から出る形も試します。
        let stubbed = p.start.is_none() && round % 3 == 2;
        if stubbed {
            let es = c.adj[start as usize].clone();
            for e in es {
                let ed = &p.edges[e as usize];
                let (w, to) = if ed.u == start { (ed.stub_u, ed.v) } else { (ed.stub_v, ed.u) };
                if w <= 0 {
                    continue;
                }
                c.used[e as usize] = true;
                c.visited[to as usize] = true;
                c.path.push(Leg { edge: e, from: start, to, mode: 1 });
                c.go(to, Some(e), w);
                c.path.pop();
                c.visited[to as usize] = false;
                c.used[e as usize] = false;
            }
        } else {
            c.visited[start as usize] = true;
            c.go(start, None, 0);
            c.visited[start as usize] = false;
        }
        round += 1;
        // 小さなグラフは、出発点をひと回りすれば十分です。
        let rounds = if p.start.is_some() { 12 } else { starts.len() * 6 };
        if clock.ms().saturating_sub(t0) >= budget_ms || round >= rounds {
            break;
        }
    }
    (c.best, c.best_route)
}
