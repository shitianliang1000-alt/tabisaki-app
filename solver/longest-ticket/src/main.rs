//! 端末から使う口。
//!
//!     longest-ticket 入力.txt          解いて JSON を出す
//!     longest-ticket --brute 入力.txt  総当たり（小さなグラフの検算用）
//!     longest-ticket --improve 入力.txt  全部は調べず、手早い探索と組み替えだけ（比べる用。limit の時間を使う）
//!     longest-ticket < 入力.txt        標準入力からも読めます

use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let brute = args.iter().any(|a| a == "--brute");
    let path = args.iter().find(|a| !a.starts_with("--"));
    let mut text = String::new();
    let read = match path {
        Some(p) => std::fs::File::open(p).and_then(|mut f| f.read_to_string(&mut text)),
        None => std::io::stdin().read_to_string(&mut text),
    };
    if let Err(e) = read {
        eprintln!("入力を読めませんでした: {}", e);
        std::process::exit(2);
    }
    let problem = match longest_ticket::parse(&text) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(2);
        }
    };
    if brute {
        println!("{{\"total\":{}}}", longest_ticket::brute::longest(&problem));
        return;
    }
    if args.iter().any(|a| a == "--improve") {
        let clock = longest_ticket::Clock::new();
        let (h, legs) = longest_ticket::heur::search(&problem, &clock, 100);
        let (t, legs) = longest_ticket::lns::improve(&problem, &legs, &clock, problem.limit_ms.max(1000));
        let checked = longest_ticket::verify(&problem, &legs).unwrap_or(-1);
        println!("{{\"heuristic\":{},\"total\":{},\"checked\":{},\"ms\":{}}}", h, t, checked, clock.ms());
        return;
    }
    match longest_ticket::solve(&problem) {
        Ok(s) => println!("{}", longest_ticket::to_json(&s)),
        Err(e) => {
            eprintln!("{}", e);
            std::process::exit(1);
        }
    }
}
