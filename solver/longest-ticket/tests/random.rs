//! 乱数で作った小さなグラフで、ソルバーの答えが総当たりと合うことを確かめます。
//!
//! ソルバー（`dp.rs`）は経路を「辺の集まり」として扱い、総当たり（`brute.rs`）は
//! 1歩ずつ伸ばします。書きかたが違う2つが、決まりの組み合わせ（出発駅の有無、
//! 通った駅で終わる形、となりの駅から出る形、通り抜けの禁止）をぜんぶ変えても
//! 同じ長さを出すことを見ます。返ってきた経路そのものも、検算に通します。

use longest_ticket::{brute, dp, heur, lns, solve, verify, Clock, Edge, Leg, Problem};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

fn random_problem(rng: &mut Rng, case: u64) -> Problem {
    let n = 2 + rng.below(8) as usize;
    let m = 1 + rng.below((n * 2) as u64) as usize;
    let mut edges = Vec::new();
    for _ in 0..m {
        let u = rng.below(n as u64) as u32;
        let mut v = rng.below(n as u64) as u32;
        if u == v {
            v = (v + 1) % n as u32;
        }
        let w = 2 + rng.below(40) as i64;
        // 半分の辺は、途中から使える。
        let stub_u = if case & 4 != 0 && rng.below(2) == 0 { 1 + rng.below((w - 1) as u64) as i64 } else { 0 };
        let stub_v = if case & 4 != 0 && rng.below(2) == 0 { 1 + rng.below((w - 1) as u64) as i64 } else { 0 };
        edges.push(Edge { u, v, w, stub_u, stub_v });
    }
    let mut forbid = Vec::new();
    if case & 8 != 0 {
        let mut taken = vec![false; n];
        for _ in 0..3 {
            let x = rng.below(n as u64) as u32;
            let at: Vec<u32> = (0..m as u32).filter(|&e| edges[e as usize].u == x || edges[e as usize].v == x).collect();
            if at.len() >= 2 && !taken[x as usize] {
                let a = at[rng.below(at.len() as u64) as usize];
                let b = at[rng.below(at.len() as u64) as usize];
                if a != b {
                    forbid.push((x, a, b));
                    taken[x as usize] = true;
                }
            }
        }
    }
    Problem {
        n,
        edges,
        start: if case & 1 != 0 { Some(rng.below(n as u64) as u32) } else { None },
        end: None,
        allow_loop: case & 2 != 0,
        forbid,
        limit_ms: 0,
        max_states: 1_000_000,
    }
}

#[test]
fn matches_brute_force_on_random_graphs() {
    let mut rng = Rng(0x1234_5678_9abc_def1);
    let mut nonzero = 0;
    for i in 0..6000u64 {
        let case = i % 16;
        let p = random_problem(&mut rng, case);
        let want = brute::longest(&p);
        let got = solve(&p).unwrap_or_else(|e| panic!("case {} #{}: {} / {:?}", case, i, e, p));
        assert!(got.proven, "case {} #{}: 証明なしで返りました {:?}", case, i, p);
        assert_eq!(got.total, want, "case {} #{}: {:?}\nroute {:?}", case, i, p, got.route);
        assert_eq!(verify(&p, &got.route).unwrap(), want);
        if want > 0 {
            nonzero += 1;
        }
    }
    assert!(nonzero > 5000);
}

/// 手早い探索（`heur`）の助けを借りずに、本体だけでも同じ答えになること。
/// 小さなグラフでは手早い探索だけで最適が見つかってしまうので、分けて確かめます。
#[test]
fn core_alone_matches_brute_force() {
    let mut rng = Rng(0x0bad_5eed_1234_4321);
    let clock = Clock::new();
    for i in 0..6000u64 {
        let case = i % 16;
        let p = random_problem(&mut rng, case);
        let want = brute::longest(&p);
        // 暫定なし（0）と、暫定がちょうど最適のとき（届かない枝をぎりぎりまで捨てる）。
        for floor in [0, want] {
            let out = dp::run(&p, floor, &clock, 0).unwrap();
            assert!(!out.truncated && !out.timed_out);
            match out.best {
                None => assert_eq!(want, 0, "case {} #{}: 経路が出ませんでした {:?}", case, i, p),
                Some((total, picks)) => {
                    assert_eq!(total, want, "case {} #{} floor {}: {:?}", case, i, floor, p);
                    let route = dp::route_of(&p, &picks).unwrap_or_else(|e| panic!("#{}: {} {:?} {:?}", i, e, p, picks));
                    assert_eq!(verify(&p, &route).unwrap_or_else(|e| panic!("#{}: {} {:?} {:?}", i, e, p, route)), want);
                }
            }
        }
    }
}

#[test]
fn larger_graphs_agree_too() {
    // 駅を増やした格子に近い形（輪が多く、境目が太くなる）。
    let mut rng = Rng(0xdead_beef_cafe_f00d);
    for i in 0..60u64 {
        let (cols, rows) = (4usize, 3usize);
        let n = cols * rows;
        let mut edges = Vec::new();
        for r in 0..rows {
            for c in 0..cols {
                let x = (r * cols + c) as u32;
                if c + 1 < cols && rng.below(5) != 0 {
                    edges.push(Edge { u: x, v: x + 1, w: 5 + rng.below(50) as i64, stub_u: 0, stub_v: 0 });
                }
                if r + 1 < rows && rng.below(5) != 0 {
                    edges.push(Edge { u: x, v: x + cols as u32, w: 5 + rng.below(50) as i64, stub_u: 0, stub_v: 0 });
                }
            }
        }
        if edges.is_empty() {
            continue;
        }
        if i % 2 == 0 {
            for e in edges.iter_mut() {
                e.stub_u = 1 + rng.below((e.w - 1) as u64) as i64;
                e.stub_v = 1 + rng.below((e.w - 1) as u64) as i64;
            }
        }
        let p = Problem {
            n,
            edges,
            start: if i % 3 == 0 { Some(rng.below(n as u64) as u32) } else { None },
            end: None,
            allow_loop: i % 4 != 3,
            forbid: vec![],
            limit_ms: 0,
            max_states: 1_000_000,
        };
        let want = brute::longest(&p);
        let got = solve(&p).unwrap();
        assert!(got.proven);
        assert_eq!(got.total, want, "#{}: {:?}", i, p);
        let alone = dp::run(&p, 0, &Clock::new(), 0).unwrap();
        assert_eq!(alone.best.map(|b| b.0).unwrap_or(0), want, "#{}: {:?}", i, p);
    }
}

#[test]
fn six_shape_and_reverse() {
    // 0 - 1 - 2 - 3 - 1 ：尾 0-1 と、輪 1-2-3-1。0 から出れば全部通れる（6の字）。
    // 輪の中から出ると、1 を二度通ることになるので、尾までは行けない。
    let edges = vec![
        Edge { u: 0, v: 1, w: 10, stub_u: 0, stub_v: 0 },
        Edge { u: 1, v: 2, w: 10, stub_u: 0, stub_v: 0 },
        Edge { u: 2, v: 3, w: 10, stub_u: 0, stub_v: 0 },
        Edge { u: 3, v: 1, w: 10, stub_u: 0, stub_v: 0 },
    ];
    let base = Problem { n: 4, edges, start: Some(0), end: None, allow_loop: true, forbid: vec![], limit_ms: 0, max_states: 1000 };
    assert_eq!(solve(&base).unwrap().total, 40);
    let from_ring = Problem { start: Some(2), ..base.clone() };
    assert_eq!(solve(&from_ring).unwrap().total, 30);
    let no_loop = Problem { allow_loop: false, ..base.clone() };
    assert_eq!(solve(&no_loop).unwrap().total, 30);
}

#[test]
fn forbidden_pass_through() {
    // 0 -a- 1 -b- 2、1 -c- 3。駅1で a と b を通り抜けてはいけない。
    let edges = vec![
        Edge { u: 0, v: 1, w: 50, stub_u: 0, stub_v: 0 },
        Edge { u: 1, v: 2, w: 50, stub_u: 0, stub_v: 0 },
        Edge { u: 1, v: 3, w: 5, stub_u: 0, stub_v: 0 },
    ];
    let p = Problem { n: 4, edges, start: None, end: None, allow_loop: true, forbid: vec![(1, 0, 1)], limit_ms: 0, max_states: 1000 };
    let s = solve(&p).unwrap();
    assert_eq!(s.total, 55); // 0-1-3 か 2-1-3。0-1-2（100）は通り抜けなので不可
    assert_eq!(brute::longest(&p), 55);
}

#[test]
fn time_limit_returns_a_candidate() {
    // 大きめの格子。制限時間1ミリ秒でも、候補と上限が返る。
    let (cols, rows) = (9usize, 9usize);
    let mut edges = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let x = (r * cols + c) as u32;
            if c + 1 < cols {
                edges.push(Edge { u: x, v: x + 1, w: 10 + ((r * 7 + c * 3) % 11) as i64, stub_u: 0, stub_v: 0 });
            }
            if r + 1 < rows {
                edges.push(Edge { u: x, v: x + cols as u32, w: 10 + ((r * 5 + c * 2) % 13) as i64, stub_u: 0, stub_v: 0 });
            }
        }
    }
    let p = Problem { n: cols * rows, edges, start: Some(0), end: None, allow_loop: true, forbid: vec![], limit_ms: 1, max_states: 50 };
    let s = solve(&p).unwrap();
    assert!(s.total > 0);
    assert!(!s.proven);
    assert!(s.upper >= s.total);
    assert_eq!(verify(&p, &s.route).unwrap(), s.total);
}

/// 出発駅と着く駅を決めた、いちばん長い道（総当たり）。lns.rs の地域の解き直しで使う形です。
fn brute_between(p: &Problem, s: u32, t: u32) -> i64 {
    fn go(p: &Problem, x: u32, t: u32, prev: Option<u32>, seen: &mut Vec<bool>, used: &mut Vec<bool>, len: i64, best: &mut i64) {
        if x == t {
            *best = (*best).max(len);
            return;
        }
        for (e, ed) in p.edges.iter().enumerate() {
            if used[e] || (ed.u != x && ed.v != x) {
                continue;
            }
            if let Some(a) = prev {
                if p.forbid.iter().any(|&(fx, fa, fb)| fx == x && ((fa == a && fb == e as u32) || (fb == a && fa == e as u32))) {
                    continue;
                }
            }
            let y = if ed.u == x { ed.v } else { ed.u };
            if seen[y as usize] {
                continue;
            }
            seen[y as usize] = true;
            used[e] = true;
            go(p, y, t, Some(e as u32), seen, used, len + ed.w, best);
            used[e] = false;
            seen[y as usize] = false;
        }
    }
    let mut best = -1;
    let mut seen = vec![false; p.n];
    seen[s as usize] = true;
    go(p, s, t, None, &mut seen, &mut vec![false; p.edges.len()], 0, &mut best);
    best
}

#[test]
fn fixed_end_matches_brute_force() {
    let mut rng = Rng(0x0bad_cafe_1234_5678);
    let mut found = 0;
    for i in 0..4000u64 {
        let mut p = random_problem(&mut rng, (i % 2) * 8);
        for e in &mut p.edges {
            e.stub_u = 0;
            e.stub_v = 0;
        }
        let s = rng.below(p.n as u64) as u32;
        let t = (s + 1 + rng.below(p.n as u64 - 1) as u32) % p.n as u32;
        p.start = Some(s);
        p.end = Some(t);
        p.allow_loop = false;
        let want = brute_between(&p, s, t);
        let out = dp::run(&p, 0, &Clock::new(), 0).unwrap();
        let got = out.best.as_ref().map(|b| b.0).unwrap_or(-1);
        // 重み0の道（s と t が同じ…にはならないので、無い）は、見つからない扱いです。
        assert_eq!(got, want, "#{}: {:?}", i, p);
        if let Some((w, picks)) = out.best {
            let legs: Vec<Leg> = dp::route_of(&p, &picks).unwrap();
            assert_eq!(legs.first().unwrap().from, s);
            assert_eq!(legs.last().unwrap().to, t);
            let mut q = p.clone();
            q.end = None;
            assert_eq!(verify(&q, &legs).unwrap(), w);
            found += 1;
        }
    }
    assert!(found > 1500, "道が見つかった回数が少なすぎます（{}）", found);
}

#[test]
fn improve_keeps_routes_valid_and_never_shorter() {
    let mut rng = Rng(0x5eed_0f_1a2b_3c4d);
    for i in 0..1500u64 {
        let case = i % 16;
        let p = random_problem(&mut rng, case);
        let clock = Clock::new();
        let (h, legs) = heur::search(&p, &clock, 1);
        let deadline = clock.ms() + 3;
        let (t, better) = lns::improve(&p, &legs, &clock, deadline);
        assert!(t >= h, "case {} #{}: 組み替えで短くなりました {} → {}", case, i, h, t);
        assert_eq!(verify(&p, &better).unwrap_or_else(|e| panic!("case {} #{}: {} {:?}\n{:?}", case, i, e, p, better)), t);
        assert!(t <= brute::longest(&p));
    }
}

#[test]
fn improve_reaches_good_routes_on_grids() {
    // 12×6 の格子。全部を調べた答えの 90% 以上に、組み替えだけで届くこと。
    let (cols, rows) = (12usize, 6usize);
    let mut rng = Rng(0x7777_1111_2222_3333);
    let mut edges = Vec::new();
    for r in 0..rows {
        for c in 0..cols {
            let x = (r * cols + c) as u32;
            if c + 1 < cols {
                edges.push(Edge { u: x, v: x + 1, w: 10 + rng.below(90) as i64, stub_u: 0, stub_v: 0 });
            }
            if r + 1 < rows {
                edges.push(Edge { u: x, v: x + cols as u32, w: 10 + rng.below(90) as i64, stub_u: 0, stub_v: 0 });
            }
        }
    }
    let p = Problem { n: cols * rows, edges, start: None, end: None, allow_loop: true, forbid: vec![], limit_ms: 0, max_states: 4_000_000 };
    let exact = solve(&p).unwrap();
    assert!(exact.proven);
    let clock = Clock::new();
    let (_, legs) = heur::search(&p, &clock, 20);
    let (t, better) = lns::improve(&p, &legs, &clock, clock.ms() + 1500);
    assert_eq!(verify(&p, &better).unwrap(), t);
    assert!(t * 100 >= exact.total * 90, "組み替え {} / 全部を調べた答え {}", t, exact.total);
}
