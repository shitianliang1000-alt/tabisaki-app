//! 最長片道切符のソルバー（Issue #431）。
//!
//! 解く問題:
//!   駅を点、路線の区間を辺（重みは営業キロ）とする多重グラフで、
//!   **同じ駅を二度通らない、いちばん長い経路**を求めます。
//!   片道切符の決まりに合わせて、次の形を認めます。
//!
//!   * 終わりだけは、すでに通った駅に着いてよい（そこで切符が終わる。
//!     「6の字」の形。出発駅に戻れば一周）。`allow_loop`
//!   * 分岐駅のとなりの駅から出る・となりの駅で終わる（分岐駅そのものは
//!     通っていないので、あとで使える）。`stub_u`・`stub_v`
//!   * ある駅で、決まった2本を乗り継がずに通り抜けてはいけない
//!     （新幹線と在来線を別の線と数える区間の決まり）。`forbid`
//!
//! 解きかたは `dp.rs` の先頭に書きました。ナイーブな深さ優先探索は
//! 使いません（日本全体では終わりません）。
//!
//! 外に頼る部品はありません（標準ライブラリだけ）。そのまま WebAssembly にも
//! なります。

pub mod brute;
pub mod dp;
pub mod heur;
pub mod lns;
pub mod order;
pub mod wasm;

/// 辺。重みは整数（0.1km 単位で渡すことを想定しています）。
#[derive(Clone, Debug)]
pub struct Edge {
    pub u: u32,
    pub v: u32,
    pub w: i64,
    /// u には触れず、u のとなりの駅と v の間だけを使うときの重み（0 = 使えない）。
    pub stub_u: i64,
    /// v には触れず、u と v のとなりの駅の間だけを使うときの重み（0 = 使えない）。
    pub stub_v: i64,
}

#[derive(Clone, Debug, Default)]
pub struct Problem {
    pub n: usize,
    pub edges: Vec<Edge>,
    /// 出発駅。None なら、どこから出てもよい。
    pub start: Option<u32>,
    /// 着く駅（lns.rs が区間を解き直すときだけ使います。start と一緒に、allow_loop = false で）。
    /// solve() には渡さないでください（手早い探索と組み替えは、これを見ません）。
    pub end: Option<u32>,
    /// 終わりで、通った駅に着いてよいか（片道 = true、往復の片道ぶん = false）。
    pub allow_loop: bool,
    /// (駅, 辺A, 辺B): その駅で A と B を乗り継がずに通り抜けてはいけない。
    pub forbid: Vec<(u32, u32, u32)>,
    /// 制限時間（ミリ秒）。0 は無制限。
    pub limit_ms: u64,
    /// 1段に持つ途中経過の上限。超えたら良い順に残し、「証明なし」で返します。
    pub max_states: usize,
}

/// 経路の1区間。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Leg {
    pub edge: u32,
    pub from: u32,
    pub to: u32,
    /// 0 = 辺の全部、1 = from には触れない（となりの駅から出る）、
    /// 2 = to には触れない（となりの駅で終わる）。
    pub mode: u8,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    pub width: usize,
    pub layers: usize,
    pub states: u64,
    pub peak: usize,
    pub heuristic: i64,
    /// 組み替え（lns.rs）のあとの長さ。組み替えなかったら 0。
    pub improved: i64,
    pub ms: u64,
    pub truncated: bool,
    pub timed_out: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Solution {
    pub total: i64,
    pub route: Vec<Leg>,
    /// 最適と証明できたか。
    pub proven: bool,
    /// これより長い経路は無い、と言える値（proven なら total と同じ）。
    pub upper: i64,
    pub stats: Stats,
}

/// 時計。WebAssembly には時計が無いので、外（JS）から借ります。
pub struct Clock {
    #[cfg(not(target_arch = "wasm32"))]
    t0: std::time::Instant,
    #[cfg(target_arch = "wasm32")]
    t0: f64,
}

impl Clock {
    pub fn new() -> Self {
        #[cfg(not(target_arch = "wasm32"))]
        {
            Clock { t0: std::time::Instant::now() }
        }
        #[cfg(target_arch = "wasm32")]
        {
            Clock { t0: wasm::now() }
        }
    }
    pub fn ms(&self) -> u64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.t0.elapsed().as_millis() as u64
        }
        #[cfg(target_arch = "wasm32")]
        {
            (wasm::now() - self.t0).max(0.0) as u64
        }
    }
}

impl Default for Clock {
    fn default() -> Self {
        Self::new()
    }
}

/// 入力の文（1行に1つ）を読みます。
///
/// ```text
/// n 5
/// e 0 1 120          辺（番号は出てきた順）: u v 重み [stub_u stub_v]
/// start 0
/// loop 1
/// forbid 2 0 3       駅2で、辺0と辺3を通り抜けない
/// limit 2000
/// maxstates 2000000
/// ```
pub fn parse(text: &str) -> Result<Problem, String> {
    let mut p = Problem { allow_loop: true, max_states: 4_000_000, ..Default::default() };
    for (ln, line) in text.lines().enumerate() {
        let line = line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let mut it = line.split_whitespace();
        let key = it.next().unwrap();
        let nums: Result<Vec<i64>, _> = it.map(|t| t.parse::<i64>()).collect();
        let nums = nums.map_err(|_| format!("{}行目: 数として読めません", ln + 1))?;
        let need = |k: usize| -> Result<(), String> {
            if nums.len() < k {
                Err(format!("{}行目: 値が足りません", ln + 1))
            } else {
                Ok(())
            }
        };
        match key {
            "n" => {
                need(1)?;
                p.n = nums[0] as usize;
            }
            "e" => {
                need(3)?;
                p.edges.push(Edge {
                    u: nums[0] as u32,
                    v: nums[1] as u32,
                    w: nums[2],
                    stub_u: *nums.get(3).unwrap_or(&0),
                    stub_v: *nums.get(4).unwrap_or(&0),
                });
            }
            "start" => {
                need(1)?;
                p.start = if nums[0] < 0 { None } else { Some(nums[0] as u32) };
            }
            "loop" => {
                need(1)?;
                p.allow_loop = nums[0] != 0;
            }
            "forbid" => {
                need(3)?;
                p.forbid.push((nums[0] as u32, nums[1] as u32, nums[2] as u32));
            }
            "limit" => {
                need(1)?;
                p.limit_ms = nums[0].max(0) as u64;
            }
            "maxstates" => {
                need(1)?;
                p.max_states = nums[0].max(1) as usize;
            }
            _ => return Err(format!("{}行目: 知らない行です（{}）", ln + 1, key)),
        }
    }
    check(&p)?;
    Ok(p)
}

/// 入力の点検。
pub fn check(p: &Problem) -> Result<(), String> {
    for (i, e) in p.edges.iter().enumerate() {
        if e.u as usize >= p.n || e.v as usize >= p.n {
            return Err(format!("辺{}: 駅の番号が範囲の外です", i));
        }
        if e.u == e.v {
            return Err(format!("辺{}: 両端が同じ駅です", i));
        }
        if e.w <= 0 {
            return Err(format!("辺{}: 重みは正の数にしてください", i));
        }
        if e.stub_u < 0 || e.stub_v < 0 || e.stub_u >= e.w || e.stub_v >= e.w {
            return Err(format!("辺{}: 途中から使うときの重みは、0 以上で全体より短くしてください", i));
        }
    }
    if let Some(s) = p.start {
        if s as usize >= p.n {
            return Err("出発駅の番号が範囲の外です".into());
        }
    }
    for &(x, a, b) in &p.forbid {
        let ok = |e: u32| {
            p.edges.get(e as usize).map(|e| e.u == x || e.v == x).unwrap_or(false)
        };
        if a == b || !ok(a) || !ok(b) {
            return Err(format!("forbid {} {} {}: その駅につながる別々の辺を2本書いてください", x, a, b));
        }
    }
    let mut seen = std::collections::HashSet::new();
    for &(x, _, _) in &p.forbid {
        if !seen.insert(x) {
            return Err(format!("forbid: 駅{}の決まりが2つあります（1駅に1つまでです）", x));
        }
    }
    Ok(())
}

/// 経路が決まりに合っているかを確かめ、長さを返します（ソルバーとは別の書きかたの検算）。
pub fn verify(p: &Problem, route: &[Leg]) -> Result<i64, String> {
    if route.is_empty() {
        return Ok(0);
    }
    let mut visited = vec![false; p.n];
    let mut used = vec![false; p.edges.len()];
    let mut total = 0i64;
    let last = route.len() - 1;
    let mut head: Option<u32> = None;
    let mut prev_edge: Option<u32> = None;
    for (i, leg) in route.iter().enumerate() {
        let e = p.edges.get(leg.edge as usize).ok_or("知らない辺です")?;
        if !((e.u == leg.from && e.v == leg.to) || (e.v == leg.from && e.u == leg.to)) {
            return Err(format!("{}番目: 辺の向きが合いません", i));
        }
        if used[leg.edge as usize] {
            return Err(format!("{}番目: 同じ辺を二度使っています", i));
        }
        used[leg.edge as usize] = true;
        match leg.mode {
            0 => total += e.w,
            1 => {
                if i != 0 || p.start.is_some() {
                    return Err("途中から出られるのは、出発駅を決めていないときの最初だけです".into());
                }
                let w = if leg.from == e.u { e.stub_u } else { e.stub_v };
                if w <= 0 {
                    return Err("この辺は途中から使えません".into());
                }
                total += w;
            }
            2 => {
                if i != last {
                    return Err("途中で終われるのは最後だけです".into());
                }
                let w = if leg.to == e.u { e.stub_u } else { e.stub_v };
                if w <= 0 {
                    return Err("この辺は途中で終われません".into());
                }
                total += w;
            }
            _ => return Err("知らない使いかたです".into()),
        }
        if i == 0 {
            if let Some(s) = p.start {
                if leg.from != s {
                    return Err("出発駅が違います".into());
                }
            }
            if leg.mode != 1 {
                visited[leg.from as usize] = true;
            }
        } else {
            if head != Some(leg.from) {
                return Err(format!("{}番目: 経路がつながっていません", i));
            }
            // 通り抜けの決まり
            let pe = prev_edge.unwrap();
            for &(x, a, b) in &p.forbid {
                if x == leg.from && ((pe == a && leg.edge == b) || (pe == b && leg.edge == a)) {
                    return Err(format!("{}番目: 駅{}で通り抜けてはいけない2本を続けて使っています", i, x));
                }
            }
        }
        if leg.mode == 2 {
            head = None;
        } else {
            if visited[leg.to as usize] {
                if i != last {
                    return Err(format!("{}番目: 同じ駅を二度通っています", i));
                }
                if !p.allow_loop {
                    return Err("通った駅に戻る終わりかたは、認めない設定です".into());
                }
            }
            visited[leg.to as usize] = true;
            head = Some(leg.to);
        }
        prev_edge = Some(leg.edge);
    }
    Ok(total)
}

/// 解きます。
///
/// 1. 手早い探索で暫定の経路を作る（`heur`）
/// 2. 辺を1本ずつ「使う・使わない」に分けて、上限が暫定に届かない枝を捨てながら
///    全部を調べる（`dp`）。制限時間や上限に当たらなければ、最適と証明できます
/// 3. 調べきれなかったら、残りの時間で経路を組み替えて伸ばす（`lns`）
pub fn solve(p: &Problem) -> Result<Solution, String> {
    check(p)?;
    let clock = Clock::new();
    let mut best = Solution::default();
    if p.edges.is_empty() {
        best.proven = true;
        return Ok(best);
    }
    // 暫定解に使う時間は、制限の1割（多くても100ミリ秒）。
    let budget = if p.limit_ms == 0 { 100 } else { (p.limit_ms / 10).clamp(5, 100) };
    let (h_total, h_route) = heur::search(p, &clock, budget);
    best.total = h_total;
    best.route = h_route;
    best.stats.heuristic = h_total;

    // 全部を調べるのに使う時間は、残りの3割。終わらなければ、残りで組み替えます
    // （日本全体だと調べきれないので、組み替えのほうに時間を回します）。
    let dp_deadline = if p.limit_ms == 0 { 0 } else { clock.ms() + p.limit_ms.saturating_sub(clock.ms()) * 3 / 10 };
    let out = dp::run(p, h_total, &clock, dp_deadline)?;
    best.stats.width = out.width;
    best.stats.layers = out.layers;
    best.stats.states = out.states;
    best.stats.peak = out.peak;
    best.stats.truncated = out.truncated;
    best.stats.timed_out = out.timed_out;
    if let Some((total, picks)) = out.best {
        if total >= best.total {
            let route = dp::route_of(p, &picks)?;
            best.total = total;
            best.route = route;
        }
    }
    best.proven = !out.truncated && !out.timed_out;
    if !best.proven {
        // 3. 調べきれなかったときは、いまの経路を組み替えて伸ばします（lns.rs）。
        let deadline = if p.limit_ms == 0 { clock.ms() + 3000 } else { p.limit_ms };
        let (t, legs) = lns::improve(p, &best.route, &clock, deadline);
        best.stats.improved = t;
        if t > best.total {
            best.total = t;
            best.route = legs;
        }
    }
    best.upper = if best.proven { best.total } else { out.upper.max(best.total) };
    let checked = verify(p, &best.route)?;
    if checked != best.total {
        return Err(format!("検算が合いません（経路 {}、報告 {}）", checked, best.total));
    }
    best.stats.ms = clock.ms();
    Ok(best)
}

/// 結果を JSON にします。
pub fn to_json(s: &Solution) -> String {
    let mut o = String::with_capacity(64 + s.route.len() * 24);
    o.push_str(&format!(
        "{{\"total\":{},\"proven\":{},\"upper\":{},\"route\":[",
        s.total, s.proven, s.upper
    ));
    for (i, l) in s.route.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str(&format!("[{},{},{},{}]", l.edge, l.from, l.to, l.mode));
    }
    o.push_str(&format!(
        "],\"stats\":{{\"width\":{},\"layers\":{},\"states\":{},\"peak\":{},\"heuristic\":{},\"improved\":{},\"ms\":{},\"truncated\":{},\"timedOut\":{}}}}}",
        s.stats.width, s.stats.layers, s.stats.states, s.stats.peak, s.stats.heuristic, s.stats.improved, s.stats.ms,
        s.stats.truncated, s.stats.timed_out
    ));
    o
}
