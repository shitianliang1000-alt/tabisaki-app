//! 経路を少しずつ組み替えて伸ばす探索（大近傍探索）。
//!
//! 日本全体の路線網では、`dp.rs` で全部を調べきるのに制限時間が足りないことが
//! あります（東京・大阪のあたりで、境目の駅が14まで増えるため）。そのときに
//! 返す候補を、ここで長くします。
//!
//! やることは単純です。いまの経路から**一続きの区間を外し**、外した両端の駅の
//! あいだを、まだ通っていない駅だけでつなぐ**いちばん長い道**を探します
//! （区間が短いので、深さ優先でも調べきれます）。長くなれば入れ替えます。
//! 経路の端は、外したあと自由に伸ばし直します（通った駅に着いて終わる形や、
//! となりの駅で終わる形も試します）。
//!
//! 行き詰まったら、ときどき少し短くなる入れ替えも受け入れて、別の形を探します
//! （焼きなまし）。**最適かどうかは、ここでは分かりません。**

use crate::{dp, Clock, Edge, Leg, Problem};

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
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Tail {
    None,
    /// となりの駅で終わる: (辺, 触れない駅)
    Stub(u32, u32),
    /// 通った駅に着いて終わる: (辺, 着く駅)
    Close(u32, u32),
}

/// 経路。`nodes[i]` と `nodes[i+1]` を `edges[i]` が結びます。
#[derive(Clone, Debug)]
struct Route {
    /// となりの駅から出る: (辺, 触れない駅)。経路は辺のもう一方の駅から始まります。
    head: Option<(u32, u32)>,
    nodes: Vec<u32>,
    edges: Vec<u32>,
    tail: Tail,
}

struct Graph<'a> {
    p: &'a Problem,
    adj: Vec<Vec<(u32, u32)>>, // 駅 → (辺, となりの駅)
    forbid: Vec<Vec<(u32, u32)>>,
}

impl Graph<'_> {
    fn w(&self, e: u32) -> i64 {
        self.p.edges[e as usize].w
    }
    /// 辺 e を、駅 x に触れずに使うときの長さ。
    fn stub(&self, e: u32, untouched: u32) -> i64 {
        let ed = &self.p.edges[e as usize];
        if ed.u == untouched {
            ed.stub_u
        } else {
            ed.stub_v
        }
    }
    #[allow(dead_code)]
    fn other(&self, e: u32, x: u32) -> u32 {
        let ed = &self.p.edges[e as usize];
        if ed.u == x {
            ed.v
        } else {
            ed.u
        }
    }
    fn blocked(&self, x: u32, a: Option<u32>, b: Option<u32>) -> bool {
        let (Some(a), Some(b)) = (a, b) else { return false };
        self.forbid[x as usize].iter().any(|&(fa, fb)| (fa == a && fb == b) || (fa == b && fb == a))
    }
    fn total(&self, r: &Route) -> i64 {
        let mut t: i64 = r.edges.iter().map(|&e| self.w(e)).sum();
        if let Some((e, u)) = r.head {
            t += self.stub(e, u);
        }
        match r.tail {
            Tail::None => {}
            Tail::Stub(e, u) => t += self.stub(e, u),
            Tail::Close(e, _) => t += self.w(e),
        }
        t
    }
}

fn to_route(g: &Graph, legs: &[Leg], fallback: u32) -> Route {
    let mut r = Route { head: None, nodes: Vec::new(), edges: Vec::new(), tail: Tail::None };
    let mut seen = vec![false; g.p.n];
    for (i, l) in legs.iter().enumerate() {
        if i == 0 {
            if l.mode == 1 {
                r.head = Some((l.edge, l.from));
                r.nodes.push(l.to);
                seen[l.to as usize] = true;
                continue;
            }
            r.nodes.push(l.from);
            seen[l.from as usize] = true;
        }
        match l.mode {
            2 => r.tail = Tail::Stub(l.edge, l.to),
            _ if seen[l.to as usize] => r.tail = Tail::Close(l.edge, l.to),
            _ => {
                r.edges.push(l.edge);
                r.nodes.push(l.to);
                seen[l.to as usize] = true;
            }
        }
    }
    if r.nodes.is_empty() {
        r.nodes.push(fallback);
    }
    r
}

fn to_legs(g: &Graph, r: &Route) -> Vec<Leg> {
    let mut out = Vec::new();
    if r.nodes.len() == 1 && r.head.is_none() && r.tail == Tail::None {
        return out;
    }
    if let Some((e, u)) = r.head {
        out.push(Leg { edge: e, from: u, to: r.nodes[0], mode: 1 });
    }
    for (i, &e) in r.edges.iter().enumerate() {
        out.push(Leg { edge: e, from: r.nodes[i], to: r.nodes[i + 1], mode: 0 });
    }
    let last = *r.nodes.last().unwrap();
    match r.tail {
        Tail::None => {}
        Tail::Stub(e, u) => out.push(Leg { edge: e, from: last, to: u, mode: 2 }),
        Tail::Close(e, y) => out.push(Leg { edge: e, from: last, to: y, mode: 0 }),
    }
    let _ = g;
    out
}

/// 深さ優先で、いちばん長い道を探す道具。
struct Dfs<'g, 'a> {
    g: &'g Graph<'a>,
    on: Vec<bool>,   // 経路の上の駅（通れない）
    used: Vec<bool>, // 使っている辺
    budget: u64,
    rng: Rng,
    // 探している途中
    path_n: Vec<u32>,
    path_e: Vec<u32>,
    best: i64,
    best_n: Vec<u32>,
    best_e: Vec<u32>,
    best_tail: Tail,
}

impl Dfs<'_, '_> {
    fn order(&mut self, x: u32) -> Vec<(u32, u32)> {
        let mut nx: Vec<(u32, u32)> = self.g.adj[x as usize].iter().copied().filter(|&(e, _)| !self.used[e as usize]).collect();
        nx.sort_by_key(|&(e, _)| -self.g.w(e));
        // ときどき順を崩して、毎回同じ道にならないようにします。
        for i in 0..nx.len() {
            if self.rng.below(3) == 0 {
                let j = self.rng.below(nx.len());
                nx.swap(i, j);
            }
        }
        nx
    }

    /// s から t まで、経路の外の駅だけを通る道。in_s: s に入ってきた辺、out_t: t から出ていく辺。
    fn between(&mut self, x: u32, t: u32, prev: Option<u32>, out_t: Option<u32>, len: i64) {
        if self.budget == 0 {
            return;
        }
        self.budget -= 1;
        for (e, y) in self.order(x) {
            if self.g.blocked(x, prev, Some(e)) {
                continue;
            }
            let w = len + self.g.w(e);
            if y == t {
                if w > self.best && !self.g.blocked(t, Some(e), out_t) {
                    self.best = w;
                    self.best_n = self.path_n.clone();
                    self.best_e = self.path_e.clone();
                    self.best_e.push(e);
                }
                continue;
            }
            if self.on[y as usize] {
                continue;
            }
            self.on[y as usize] = true;
            self.used[e as usize] = true;
            self.path_n.push(y);
            self.path_e.push(e);
            self.between(y, t, Some(e), out_t, w);
            self.path_e.pop();
            self.path_n.pop();
            self.used[e as usize] = false;
            self.on[y as usize] = false;
            if self.budget == 0 {
                return;
            }
        }
    }

    /// x から先を、経路の外の駅で伸ばす（どこで終わってもよい）。
    fn extend(&mut self, x: u32, prev: Option<u32>, len: i64, allow_loop: bool) {
        if len > self.best {
            self.best = len;
            self.best_n = self.path_n.clone();
            self.best_e = self.path_e.clone();
            self.best_tail = Tail::None;
        }
        if self.budget == 0 {
            return;
        }
        self.budget -= 1;
        for (e, y) in self.order(x) {
            if self.g.blocked(x, prev, Some(e)) {
                continue;
            }
            // となりの駅で終わる
            let s = self.g.stub(e, y);
            if s > 0 && len + s > self.best {
                self.best = len + s;
                self.best_n = self.path_n.clone();
                self.best_e = self.path_e.clone();
                self.best_tail = Tail::Stub(e, y);
            }
            let w = len + self.g.w(e);
            if self.on[y as usize] {
                // 通った駅に着いて終わる
                if allow_loop && w > self.best {
                    self.best = w;
                    self.best_n = self.path_n.clone();
                    self.best_e = self.path_e.clone();
                    self.best_tail = Tail::Close(e, y);
                }
                continue;
            }
            self.on[y as usize] = true;
            self.used[e as usize] = true;
            self.path_n.push(y);
            self.path_e.push(e);
            self.extend(y, Some(e), w, allow_loop);
            self.path_e.pop();
            self.path_n.pop();
            self.used[e as usize] = false;
            self.on[y as usize] = false;
            if self.budget == 0 {
                return;
            }
        }
    }
}

struct State<'g, 'a> {
    dfs: Dfs<'g, 'a>,
    r: Route,
}

impl<'g, 'a> State<'g, 'a> {
    fn mark(&mut self) {
        let d = &mut self.dfs;
        d.on.iter_mut().for_each(|v| *v = false);
        d.used.iter_mut().for_each(|v| *v = false);
        for &x in &self.r.nodes {
            d.on[x as usize] = true;
        }
        for &e in &self.r.edges {
            d.used[e as usize] = true;
        }
        if let Some((e, _)) = self.r.head {
            d.used[e as usize] = true;
        }
        match self.r.tail {
            Tail::Stub(e, _) | Tail::Close(e, _) => d.used[e as usize] = true,
            Tail::None => {}
        }
    }

    /// i..j の区間（i < j）を、もっと長い回り道に替えます。改善したら true。
    fn window(&mut self, i: usize, j: usize, budget: u64, slack: i64) -> bool {
        let r = &self.r;
        let k = r.edges.len();
        if let Tail::Close(_, y) = r.tail {
            // 着いて終わる駅が区間の中にあると、外せません。
            if r.nodes[i + 1..j].contains(&y) {
                return false;
            }
        }
        let g = self.dfs.g;
        let old: i64 = r.edges[i..j].iter().map(|&e| g.w(e)).sum();
        let prev = if i > 0 { Some(r.edges[i - 1]) } else { r.head.map(|h| h.0) };
        let out_t = if j < k {
            Some(r.edges[j])
        } else {
            match r.tail {
                Tail::Stub(e, _) | Tail::Close(e, _) => Some(e),
                Tail::None => None,
            }
        };
        let (s, t) = (r.nodes[i], r.nodes[j]);
        let inner: Vec<u32> = r.nodes[i + 1..j].to_vec();
        let seg: Vec<u32> = r.edges[i..j].to_vec();
        let d = &mut self.dfs;
        for &x in &inner {
            d.on[x as usize] = false;
        }
        for &e in &seg {
            d.used[e as usize] = false;
        }
        d.budget = budget;
        d.best = old - slack;
        d.best_e.clear();
        d.best_n.clear();
        d.path_n.clear();
        d.path_e.clear();
        d.between(s, t, prev, out_t, 0);
        let found = !d.best_e.is_empty() && d.best > old - slack;
        let (nn, ne) = if found { (d.best_n.clone(), d.best_e.clone()) } else { (inner.clone(), seg.clone()) };
        for &x in &nn {
            d.on[x as usize] = true;
        }
        for &e in &ne {
            d.used[e as usize] = true;
        }
        if !found {
            return false;
        }
        let r = &mut self.r;
        r.nodes.splice(i + 1..j, nn);
        r.edges.splice(i..j, ne);
        true
    }

    /// i..j の区間のまわりの地域を切り出し、その中の道を dp.rs で解き直します。
    ///
    /// 深さ優先（window）では調べきれない広さでも、地域が小さければ全部を調べられます。
    /// 地域は、区間の駅から、経路に入っていない駅を近い順に max_nodes 駅まで足したものです。
    fn region(&mut self, i: usize, j: usize, max_nodes: usize, clock: &Clock, deadline: u64) -> bool {
        let g = self.dfs.g;
        let r = &self.r;
        let k = r.edges.len();
        if let Tail::Close(_, y) = r.tail {
            if r.nodes[i + 1..j].contains(&y) {
                return false;
            }
        }
        let old: i64 = r.edges[i..j].iter().map(|&e| g.w(e)).sum();
        let prev = if i > 0 { Some(r.edges[i - 1]) } else { r.head.map(|h| h.0) };
        let out_t = if j < k {
            Some(r.edges[j])
        } else {
            match r.tail {
                Tail::Stub(e, _) | Tail::Close(e, _) => Some(e),
                Tail::None => None,
            }
        };
        let (s, t) = (r.nodes[i], r.nodes[j]);
        let inner: Vec<u32> = r.nodes[i + 1..j].to_vec();
        let seg: Vec<u32> = r.edges[i..j].to_vec();
        let n = g.p.n;
        // 地域を集めます（区間の駅 → 経路の外の駅を、幅優先で）。
        let mut id = vec![u32::MAX; n];
        let mut members: Vec<u32> = Vec::new();
        let add = |x: u32, id: &mut Vec<u32>, members: &mut Vec<u32>| {
            if id[x as usize] == u32::MAX {
                id[x as usize] = members.len() as u32;
                members.push(x);
            }
        };
        add(s, &mut id, &mut members);
        add(t, &mut id, &mut members);
        for &x in &inner {
            add(x, &mut id, &mut members);
        }
        let mut queue: std::collections::VecDeque<u32> = inner.iter().copied().collect();
        queue.push_back(s);
        queue.push_back(t);
        while let Some(x) = queue.pop_front() {
            if members.len() >= max_nodes {
                break;
            }
            for &(_, y) in &g.adj[x as usize] {
                if members.len() >= max_nodes {
                    break;
                }
                if id[y as usize] == u32::MAX && !self.dfs.on[y as usize] {
                    add(y, &mut id, &mut members);
                    queue.push_back(y);
                }
            }
        }
        // 地域の中の、使っていない辺（外す区間の辺は使ってよい）。
        let freed: std::collections::HashSet<u32> = seg.iter().copied().collect();
        let mut sub_edges: Vec<Edge> = Vec::new();
        let mut back: Vec<u32> = Vec::new();
        let mut sub_of = std::collections::HashMap::new();
        for (e, ed) in g.p.edges.iter().enumerate() {
            let (a, b) = (id[ed.u as usize], id[ed.v as usize]);
            if a == u32::MAX || b == u32::MAX || (self.dfs.used[e] && !freed.contains(&(e as u32))) {
                continue;
            }
            sub_of.insert(e as u32, sub_edges.len() as u32);
            sub_edges.push(Edge { u: a, v: b, w: ed.w, stub_u: 0, stub_v: 0 });
            back.push(e as u32);
        }
        // 通り抜けの決まり。区間の外の辺は、仮の辺（出発 = m、着く = m+1）に置き換えます。
        let m = sub_edges.len() as u32;
        let mut forbid = Vec::new();
        for &(x, a, b) in &g.p.forbid {
            if id[x as usize] == u32::MAX {
                continue;
            }
            let map = |e: u32| -> Option<u32> {
                if let Some(&se) = sub_of.get(&e) {
                    Some(se)
                } else if x == s && Some(e) == prev {
                    Some(m)
                } else if x == t && Some(e) == out_t {
                    Some(m + 1)
                } else {
                    None
                }
            };
            if let (Some(sa), Some(sb)) = (map(a), map(b)) {
                forbid.push((id[x as usize], sa, sb));
            }
        }
        let sub = Problem {
            n: members.len(),
            edges: sub_edges,
            start: Some(0),
            end: Some(1),
            allow_loop: false,
            forbid,
            limit_ms: 0,
            max_states: 400_000,
        };
        let res = dp::run(&sub, old + 1, clock, deadline);
        let Ok(out) = res else { return false };
        let Some((w, picks)) = out.best else { return false };
        if w <= old {
            return false;
        }
        let Ok(legs) = dp::route_of(&sub, &picks) else { return false };
        // 地域の答えを、もとの番号に戻して差し替えます。
        let mut nn = Vec::new();
        let mut ne = Vec::new();
        for (q, l) in legs.iter().enumerate() {
            ne.push(back[l.edge as usize]);
            if q + 1 < legs.len() {
                nn.push(members[l.to as usize]);
            } else if members[l.to as usize] != t {
                return false;
            }
        }
        if legs.first().map(|l| members[l.from as usize]) != Some(s) {
            return false;
        }
        let d = &mut self.dfs;
        for &x in &inner {
            d.on[x as usize] = false;
        }
        for &e in &seg {
            d.used[e as usize] = false;
        }
        for &x in &nn {
            d.on[x as usize] = true;
        }
        for &e in &ne {
            d.used[e as usize] = true;
        }
        let r = &mut self.r;
        r.nodes.splice(i + 1..j, nn);
        r.edges.splice(i..j, ne);
        true
    }

    /// 終わりの m 本を外して、伸ばし直します。
    fn tail(&mut self, m: usize, budget: u64, slack: i64, allow_loop: bool) -> bool {
        let g = self.dfs.g;
        let k = self.r.edges.len();
        let m = m.min(k);
        let cut_n: Vec<u32> = self.r.nodes[k + 1 - m..].to_vec();
        let cut_e: Vec<u32> = self.r.edges[k - m..].to_vec();
        let old_tail = self.r.tail;
        let old: i64 = cut_e.iter().map(|&e| g.w(e)).sum::<i64>()
            + match old_tail {
                Tail::None => 0,
                Tail::Stub(e, u) => g.stub(e, u),
                Tail::Close(e, _) => g.w(e),
            };
        let x = self.r.nodes[k - m];
        let prev = if k - m > 0 { Some(self.r.edges[k - m - 1]) } else { self.r.head.map(|h| h.0) };
        let d = &mut self.dfs;
        for &y in &cut_n {
            d.on[y as usize] = false;
        }
        for &e in &cut_e {
            d.used[e as usize] = false;
        }
        if let Tail::Stub(e, _) | Tail::Close(e, _) = old_tail {
            d.used[e as usize] = false;
        }
        d.budget = budget;
        d.best = i64::MIN;
        d.best_tail = Tail::None;
        d.path_n.clear();
        d.path_e.clear();
        d.extend(x, prev, 0, allow_loop);
        if d.best > old - slack && !(d.best == old && d.best_e == cut_e && d.best_tail == old_tail) {
            let (nn, ne, nt) = (d.best_n.clone(), d.best_e.clone(), d.best_tail);
            for &y in &nn {
                d.on[y as usize] = true;
            }
            for &e in &ne {
                d.used[e as usize] = true;
            }
            if let Tail::Stub(e, _) | Tail::Close(e, _) = nt {
                d.used[e as usize] = true;
            }
            let r = &mut self.r;
            r.nodes.truncate(k + 1 - m);
            r.edges.truncate(k - m);
            r.nodes.extend(nn);
            r.edges.extend(ne);
            r.tail = nt;
            return true;
        }
        for &y in &cut_n {
            d.on[y as usize] = true;
        }
        for &e in &cut_e {
            d.used[e as usize] = true;
        }
        if let Tail::Stub(e, _) | Tail::Close(e, _) = old_tail {
            d.used[e as usize] = true;
        }
        false
    }

    /// 向きを逆にします（出発の側を伸ばすため）。着いて終わる形・出発駅が決まっているときはできません。
    fn reverse(&mut self) -> bool {
        if matches!(self.r.tail, Tail::Close(..)) {
            return false;
        }
        let r = &mut self.r;
        r.nodes.reverse();
        r.edges.reverse();
        let head = r.head;
        r.head = match r.tail {
            Tail::Stub(e, u) => Some((e, u)),
            _ => None,
        };
        r.tail = match head {
            Some((e, u)) => Tail::Stub(e, u),
            None => Tail::None,
        };
        true
    }

    /// 出発の側を、となりの駅から出る形にできるなら、長いほうにします。
    fn best_head(&mut self) {
        let g = self.dfs.g;
        if g.p.start.is_some() {
            return;
        }
        let x = self.r.nodes[0];
        let first = self.r.edges.first().copied().or(match self.r.tail {
            Tail::Stub(e, _) | Tail::Close(e, _) => Some(e),
            Tail::None => None,
        });
        let cur = self.r.head.map(|(e, u)| g.stub(e, u)).unwrap_or(0);
        if let Some((e, _)) = self.r.head {
            self.dfs.used[e as usize] = false;
        }
        let mut best = (cur, self.r.head);
        for &(e, y) in &g.adj[x as usize] {
            if self.dfs.used[e as usize] || g.blocked(x, Some(e), first) {
                continue;
            }
            let s = g.stub(e, y);
            if s > best.0 {
                best = (s, Some((e, y)));
            }
        }
        self.r.head = best.1;
        if let Some((e, _)) = self.r.head {
            self.dfs.used[e as usize] = true;
        }
    }
}

/// legs から始めて、deadline（clock の値）まで改良します。
pub fn improve(p: &Problem, legs: &[Leg], clock: &Clock, deadline: u64) -> (i64, Vec<Leg>) {
    let mut adj = vec![Vec::new(); p.n];
    for (i, e) in p.edges.iter().enumerate() {
        adj[e.u as usize].push((i as u32, e.v));
        adj[e.v as usize].push((i as u32, e.u));
    }
    let mut forbid = vec![Vec::new(); p.n];
    for &(x, a, b) in &p.forbid {
        forbid[x as usize].push((a, b));
    }
    let g = Graph { p, adj, forbid };
    let start_node = p.start.unwrap_or_else(|| (0..p.n as u32).find(|&x| !g.adj[x as usize].is_empty()).unwrap_or(0));
    let mut st = State {
        dfs: Dfs {
            g: &g,
            on: vec![false; p.n],
            used: vec![false; p.edges.len()],
            budget: 0,
            rng: Rng(0x2545_f491_4f6c_dd1d),
            path_n: Vec::new(),
            path_e: Vec::new(),
            best: 0,
            best_n: Vec::new(),
            best_e: Vec::new(),
            best_tail: Tail::None,
        },
        r: to_route(&g, legs, start_node),
    };
    if p.start.is_some() && (st.r.head.is_some() || st.r.nodes[0] != start_node) {
        st.r = Route { head: None, nodes: vec![start_node], edges: Vec::new(), tail: Tail::None };
    }
    st.mark();
    let mut cur = g.total(&st.r);
    let mut best = (cur, st.r.clone());
    let total_w: i64 = p.edges.iter().map(|e| e.w).sum::<i64>().max(1);
    let t0 = clock.ms();
    let span = deadline.saturating_sub(t0).max(1) as f64;
    let mut iter = 0u64;
    let mut since = 0u64;
    // 地域ごと解き直すときの大きさ（区間の本数・地域の駅の数・1回の時間）。
    // 大きくしても、日本全体の答えは長くなりませんでした（docs/longest-ticket.md）。
    let (region_len, region_min, region_span, region_ms) = (30usize, 24usize, 40usize, 300u64);
    loop {
        iter += 1;
        if iter % 16 == 0 && clock.ms() >= deadline {
            break;
        }
        // 温度: はじめは全体の 0.3% ほどの悪化まで受け入れ、時間とともに 0 へ。
        let frac = ((clock.ms().saturating_sub(t0)) as f64 / span).min(1.0);
        let temp = (total_w as f64) * 0.003 * (1.0 - frac);
        let slack = if st.dfs.rng.below(4) == 0 { (temp * -st.dfs.rng.unit().max(1e-9).ln()) as i64 } else { 0 };
        let k = st.r.edges.len();
        let roll = st.dfs.rng.below(100);
        let changed = if k >= 1 && roll < 60 {
            // 短い区間を、長い回り道に。
            let len = 1 + st.dfs.rng.below(k.min(8));
            let i = st.dfs.rng.below(k + 1 - len);
            st.window(i, i + len, 3000, slack)
        } else if k >= 6 && roll < 75 && roll >= 70 {
            // 少し長い区間を、時間をかけて。
            let len = 6 + st.dfs.rng.below(k.min(20) - 5);
            let i = st.dfs.rng.below(k + 1 - len);
            st.window(i, i + len, 20000, slack)
        } else if k >= 4 && roll < 70 {
            // 地域ごと解き直す（dp.rs）。
            let len = 2 + st.dfs.rng.below(k.min(region_len) - 1);
            let i = st.dfs.rng.below(k + 1 - len);
            let size = region_min + st.dfs.rng.below(region_span);
            let until = (clock.ms() + region_ms).min(deadline);
            st.region(i, i + len, size, clock, until)
        } else if k >= 10 && roll < 80 {
            // ゆさぶり: 長い区間を、見つかった別の道に替える（短くなってもよい）。
            let len = 10 + st.dfs.rng.below(k.min(30) - 9);
            let i = st.dfs.rng.below(k + 1 - len);
            st.window(i, i + len, 2000, i64::MAX / 4)
        } else if roll < 96 || p.start.is_some() {
            let m = st.dfs.rng.below(k.min(12) + 1);
            st.tail(m, 8000, slack, p.allow_loop)
        } else {
            st.reverse()
        };
        if changed {
            st.best_head();
            cur = g.total(&st.r);
            if cur > best.0 {
                best = (cur, st.r.clone());
                since = 0;
            }
        }
        since += 1;
        // しばらく良くならなければ、いちばん良かった形に戻ってやり直します。
        if since > 20000 && cur < best.0 {
            st.r = best.1.clone();
            st.mark();
            cur = best.0;
            since = 0;
        }
    }
    (best.0, to_legs(&g, &best.1))
}
