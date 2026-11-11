//! 辺を調べる順番を決めます。
//!
//! `dp.rs` は、辺を1本ずつ順に「使う・使わない」と決めていきます。途中で覚えて
//! おくのは、**すでに辺が出てきて、まだ残りの辺もある駅**（境目の駅）の
//! 様子だけです。境目の駅が少ないほど、まとめられる途中経過が増えて速くなります。
//!
//! 日本の路線網は細長いので、端から順に掃いていくと境目は10駅前後で済みます。
//! どの駅から掃き始めるのが良いかは形によるので、ぜんぶの駅から幅優先で
//! 並べてみて、境目がいちばん細くなる順番を選びます（数百駅なら一瞬です）。

pub struct Plan {
    /// 調べる順に並べた辺の番号。
    pub order: Vec<usize>,
    /// 各手で、辺の両端の駅が入っている枠。
    pub slot_u: Vec<u8>,
    pub slot_v: Vec<u8>,
    /// この手のあと、その駅の辺はもう出てこない。
    pub fin_u: Vec<bool>,
    pub fin_v: Vec<bool>,
    /// 同時に覚えておく駅の数の最大。
    pub width: usize,
}

fn bfs_order(n: usize, adj: &[Vec<u32>], root: usize) -> Vec<u32> {
    let mut pos = vec![u32::MAX; n];
    let mut next = 0u32;
    let mut queue = std::collections::VecDeque::new();
    let mut roots = std::iter::once(root).chain(0..n);
    loop {
        let Some(r) = roots.next() else { break };
        if pos[r] != u32::MAX {
            continue;
        }
        pos[r] = next;
        next += 1;
        queue.push_back(r);
        while let Some(x) = queue.pop_front() {
            for &y in &adj[x] {
                let y = y as usize;
                if pos[y] == u32::MAX {
                    pos[y] = next;
                    next += 1;
                    queue.push_back(y);
                }
            }
        }
    }
    pos
}

fn edge_order(pos: &[u32], ends: &[(u32, u32)]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..ends.len()).collect();
    order.sort_by_key(|&i| {
        let (a, b) = (pos[ends[i].0 as usize], pos[ends[i].1 as usize]);
        (a.max(b), a.min(b), i)
    });
    order
}

/// 境目の太さ（最大と、合計）。
fn cost(n: usize, ends: &[(u32, u32)], order: &[usize]) -> (usize, u64) {
    let mut last = vec![0usize; n];
    for (step, &e) in order.iter().enumerate() {
        last[ends[e].0 as usize] = step;
        last[ends[e].1 as usize] = step;
    }
    let mut active = vec![false; n];
    let mut count = 0usize;
    let (mut width, mut sum) = (0usize, 0u64);
    for (step, &e) in order.iter().enumerate() {
        for x in [ends[e].0 as usize, ends[e].1 as usize] {
            if !active[x] {
                active[x] = true;
                count += 1;
            }
        }
        width = width.max(count);
        for x in [ends[e].0 as usize, ends[e].1 as usize] {
            if active[x] && last[x] == step {
                active[x] = false;
                count -= 1;
            }
        }
        // 太いところほど重く数えます（途中経過の数は、太さに対して指数で増えます）。
        sum += 1u64 << count.min(40);
    }
    (width, sum)
}

pub fn plan(n: usize, ends: &[(u32, u32)]) -> Plan {
    let mut adj = vec![Vec::new(); n];
    for &(u, v) in ends {
        adj[u as usize].push(v);
        adj[v as usize].push(u);
    }
    let mut best: Option<((usize, u64), Vec<usize>)> = None;
    for root in 0..n.max(1) {
        if n == 0 {
            break;
        }
        if adj[root].is_empty() {
            continue;
        }
        let pos = bfs_order(n, &adj, root);
        let order = edge_order(&pos, ends);
        let c = cost(n, ends, &order);
        if best.as_ref().map(|(b, _)| c < *b).unwrap_or(true) {
            best = Some((c, order));
        }
    }
    let order = best.map(|(_, o)| o).unwrap_or_default();

    // 枠の割り当て。駅は、最初の辺で枠をもらい、最後の辺で返します。
    let mut last = vec![0usize; n];
    for (step, &e) in order.iter().enumerate() {
        last[ends[e].0 as usize] = step;
        last[ends[e].1 as usize] = step;
    }
    let mut slot_of = vec![u8::MAX; n];
    let mut free: Vec<u8> = Vec::new();
    let mut high = 0u8;
    let mut width = 0usize;
    let (mut slot_u, mut slot_v, mut fin_u, mut fin_v) = (vec![], vec![], vec![], vec![]);
    for (step, &e) in order.iter().enumerate() {
        let (u, v) = (ends[e].0 as usize, ends[e].1 as usize);
        for x in [u, v] {
            if slot_of[x] == u8::MAX {
                slot_of[x] = free.pop().unwrap_or_else(|| {
                    high += 1;
                    high - 1
                });
            }
        }
        width = width.max(high as usize);
        slot_u.push(slot_of[u]);
        slot_v.push(slot_of[v]);
        let (fu, fv) = (last[u] == step, last[v] == step);
        fin_u.push(fu);
        fin_v.push(fv);
        if fu {
            free.push(slot_of[u]);
        }
        if fv {
            free.push(slot_of[v]);
        }
        free.sort_unstable_by(|a, b| b.cmp(a)); // 小さい番号の枠から使う
    }
    Plan { order, slot_u, slot_v, fin_u, fin_v, width }
}
