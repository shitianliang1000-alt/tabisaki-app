// 待っているあいだに、旅が形になっていくのを見せる。
//
// 旅程を組むのに、1〜2分かかります（電車・バスの時刻を1区間ずつ
// 実際に調べているためです）。そのあいだ画面にあったのは、6段の
// 一覧と経過時間だけでした。**止まっていないことは分かるが、
// 何が起きているのかは分からない**画面です。
//
// 画像生成のアプリ（Image Playground や ChatGPT の画像）は、待っている
// あいだに絵が少しずつ現れます。待ち時間そのものが見ものになっています。
// 同じことを、**持っているデータだけで**やります。
//
//   ・出発地が、点として置かれる
//   ・旅先の収録スポットが、読み込まれたぶんだけ星座のように現れる
//   ・候補が絞られると、その星だけが明るくなる
//   ・並べる順が試されるたび、線が引き直される（実際に試しています）
//   ・決まった順で、線が落ち着く
//
// 描いているのは**本物の座標**です。飾りの絵ではなく、いま組んでいる
// 旅そのものです。下に流れる一言も、収録の説明文からそのまま取ります
// （「出雲大社 — 大注連縄で知られる縁結びの社」）。待っているあいだに、
// 行き先のことを少し知れます。
//
// 書かないこと
// ------------
// ・外のサービスに絵を頼みません（CSP は script-src 'self' で、鍵も
//   要りません。圏外でも動きます）。
// ・「動きを減らす」設定では、瞬きも引き直しも止めます。段が進んだ
//   ときに、静かに描き直すだけです。

/** 描く星の上限。多すぎると星座ではなく雪になります。 */
const MAX_STARS = 320;

/** 一言を入れ替える間隔（ms）。読み終わる前に変わると、読めません。 */
const CAPTION_MS = 5200;

/**
 * 地図を消すまで待つ時間（ms）。Leaflet のズームの片付けは 250ms 後に
 * 走ります。動きを始める1コマぶんの遅れも見込んで、それより長く待ちます。
 */
const MAP_SETTLE_MS = 400;

function reduceMotion() {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")
      ?.matches === true;
  } catch { return false; }
}

/** 決まった種から、毎回同じ乱数を出します（同じ旅なら同じ絵）。 */
function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 4294967296;
  };
}

function seedOf(trip) {
  const t = `${trip?.origin?.lat ?? 0},${trip?.origin?.lng ?? 0},${trip?.note ?? ""}`;
  let h = 2166136261;
  for (let i = 0; i < t.length; i += 1) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 絵の状態。段が進むたびに、外から書き換えます。
 *
 * @typedef {object} SketchState
 * @property {{lat:number,lng:number}|null} origin 出発地
 * @property {Array<{lat:number,lng:number,name?:string}>} stars 収録スポット
 * @property {Array<{lat:number,lng:number,name?:string,description?:string}>} picks 候補
 * @property {Array<{lat:number,lng:number}>} route 決まった順
 * @property {number} step いまの段
 */

/**
 * 待ち画面に絵を置きます。
 *
 * 止めかたは「札が画面から消えたら」です（時計と同じ作法）。
 *
 * @param {HTMLElement} card .plan-card
 * @param {{trip?:object}} ctx
 * @returns {{update:(patch:Partial<SketchState>)=>void, stop:()=>void}}
 */
export function mountSketch(card, ctx = {}) {
  const wrap = document.createElement("div");
  wrap.className = "sketch";
  // 地の形を、絵の下に敷きます。
  //
  // 星（収録スポット）は本物の座標で打っていますが、**地の形が無いと
  // ただの点の散らばり**でした。「どこを探しているのか」が読めません。
  // 地図を敷くと、点が海岸線や街の並びの上に乗り、探している土地が
  // 一目で分かります。
  //
  // 地図は Leaflet に任せます。**投影を自分で近似しません。**
  // 近似すると、拡大したときに点が地図から少しずつずれます
  //（メルカトルと正距円筒の差です）。Leaflet の投影をそのまま使って
  // 点を置けば、ずれようがありません。
  const mapEl = document.createElement("div");
  mapEl.className = "sketch-map";
  mapEl.setAttribute("aria-hidden", "true");
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const caption = document.createElement("p");
  caption.className = "sketch-caption";
  caption.setAttribute("aria-live", "off");
  // 地図と絵は重ねますが、**下の一言は重ねません**。重ねると、
  // 地図の上に字が乗り、出どころの表示とも噛み合いません。
  const stage = document.createElement("div");
  stage.className = "sketch-stage";
  stage.append(mapEl, canvas);
  wrap.append(stage, caption);
  card.prepend(wrap);

  const state = {
    origin: ctx.trip?.origin ?? null,
    stars: [], picks: [], route: [], step: 0,
  };
  // 星は、**取りに行く関数**でも受け取ります。
  //
  // 収録は県ごとに遅れて読まれます。段が進んだ瞬間の写しを渡すと、
  // 読み込みが終わる前の空の写しのまま、次の段まで何も現れません
  // （実際そうなりました。「候補地を探しています」のあいだ、絵は
  // 出発地の点1つでした）。関数なら、読み込まれたぶんだけ星が増えて
  // いきます。それがこの絵のいちばん見たいところです。
  let starsFn = null;
  let starsAt = 0;
  const random = rng(seedOf(ctx.trip));
  // 星ごとの瞬きの位相。同じ旅なら同じ瞬きです。
  const phases = new Map();
  const still = reduceMotion();
  let frame = 0;
  let stopped = false;
  let lastCaptionAt = 0;
  let captionIdx = -1;
  // 線を引き直す「試し」。実際の planner も並べる順を何度も試します。
  let trial = [];
  let trialAt = 0;
  let trialProgress = 0;

  const gfx = canvas.getContext("2d");
  if (!gfx) return { update() {}, stop() {} };

  // 地図。Leaflet が読めていないとき（圏外・古い端末）は作りません。
  // そのときは、これまでどおり点と線だけが出ます。**地図が無いことで
  // 絵が出なくなる、ということにはしません。**
  let map = null;
  let fitAt = 0;
  let fitKey = "";
  try {
    const L = globalThis.L;
    if (L && ctx.tileUrl) {
      map = L.map(mapEl, {
        // 触れません。待っているあいだの絵で、動かすものではありません。
        zoomControl: false, attributionControl: true,
        dragging: false, scrollWheelZoom: false, doubleClickZoom: false,
        boxZoom: false, keyboard: false, touchZoom: false,
        // 「動きを減らす」設定のときは、寄せる動きも出しません。
        fadeAnimation: !still, zoomAnimation: !still,
      }).setView([36.2, 138.2], 5);
      L.tileLayer(ctx.tileUrl, {
        attribution: ctx.attribution ?? "", maxZoom: 17,
      }).addTo(map);
      // 押せるものではないので、読み上げにも操作にも出しません。
      mapEl.setAttribute("tabindex", "-1");
    }
  } catch {
    // 地図が作れなくても、絵は出します。
    map = null;
  }

  function size() {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    const w = wrap.clientWidth || 400;
    const h = Math.round(Math.min(220, Math.max(150, w * 0.5)));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    gfx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  /** 何を描くかで、地図の範囲を決めます。 */
  function bounds() {
    const pts = [];
    if (state.route.length) pts.push(...state.route);
    else if (state.picks.length) pts.push(...state.picks);
    else if (state.stars.length) pts.push(...state.stars);
    if (state.origin && (pts.length === 0 || state.step === 0)) pts.push(state.origin);
    if (!pts.length) return null;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of pts) {
      if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue;
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
    }
    if (!Number.isFinite(minLat)) return null;
    // 余白は、広がりに対する割合で取ります。
    //
    // ここは「最低 0.05度」を下限にしていました。点だけの絵なら
    // 気になりませんが、**地図を敷くと効きすぎます**。鎌倉の5か所
    // （0.02度ほど）に 0.05度の余白を付けると、両側で6倍に広がり、
    // 相模湾から横浜まで入った縮尺になります。探している場所が
    // 豆粒になって、何を見ているのか分かりません。
    //
    // 下限は「1点しかない（広がりが無い）」ときだけにします。
    const spanLat = maxLat - minLat;
    const spanLng = maxLng - minLng;
    const padLat = spanLat < 0.005 ? 0.02 : spanLat * 0.18;
    const padLng = spanLng < 0.005 ? 0.02 : spanLng * 0.18;
    return { minLat: minLat - padLat, maxLat: maxLat + padLat,
             minLng: minLng - padLng, maxLng: maxLng + padLng };
  }

  function project(b, w, h) {
    // 緯度1度と経度1度の長さの違いを、ざっくり合わせます。
    const kx = Math.cos(((b.minLat + b.maxLat) / 2) * Math.PI / 180);
    const spanX = (b.maxLng - b.minLng) * kx;
    const spanY = b.maxLat - b.minLat;
    const scale = Math.min((w - 24) / spanX, (h - 24) / spanY);
    const ox = (w - spanX * scale) / 2;
    const oy = (h - spanY * scale) / 2;
    return (p) => ({
      x: ox + (p.lng - b.minLng) * kx * scale,
      y: oy + (b.maxLat - p.lat) * scale,
    });
  }

  function color(name, fallback) {
    try {
      const v = getComputedStyle(card).getPropertyValue(name).trim();
      return v || fallback;
    } catch { return fallback; }
  }

  /**
   * 地図を、いま描く範囲に合わせます。
   *
   * 毎コマ寄せ直すと、地図が震えて読めません。範囲が変わったときだけ、
   * それも1.2秒に1回までにします。
   */
  function fitMap(b, now) {
    if (!map) return;
    // 札を置いた直後は、まだ高さが 0 です。そのまま寄せると世界地図の
    // ままになり、**点が中央に固まって見えます**（実際そうなりました）。
    // 大きさが取れるまで、寄せ直しを諦めません。
    let sized = false;
    try {
      const sz = map.getSize();
      sized = sz && sz.x > 0 && sz.y > 0;
    } catch { sized = false; }
    const key = [b.minLat, b.maxLat, b.minLng, b.maxLng]
      .map((v) => v.toFixed(3)).join(",") + `|${Math.round(wrap.clientWidth)}`;
    if (sized && key === fitKey) return;
    if (now - fitAt < 400) return;
    fitAt = now;
    try {
      map.invalidateSize({ animate: false });
      const sz = map.getSize();
      if (!sz || sz.x <= 0 || sz.y <= 0) return;   // まだ置かれていません
      fitKey = key;
      map.fitBounds([[b.minLat, b.minLng], [b.maxLat, b.maxLng]],
        { animate: !still, padding: [8, 8], maxZoom: 15 });
    } catch { /* 寄せられなくても、点は描けます */ }
  }

  function draw(now) {
    const { w, h } = size();
    gfx.clearRect(0, 0, w, h);
    const b = bounds();
    if (!b) return;
    fitMap(b, now);
    // 点を置く場所は、**地図があるなら地図に聞きます**。自分で
    // 投影を近似すると、拡大したときに地図と点がずれます。
    const to = map
      ? (p) => {
        const q = map.latLngToContainerPoint([p.lat, p.lng]);
        return { x: q.x, y: q.y };
      }
      : project(b, w, h);
    const ink = color("--tabi-indigo", "#111111");
    const teal = color("--tabi-teal", "#333333");
    const faint = color("--hig-label-4", "rgba(60,60,67,.18)");

    // 星。読み込まれた収録スポット。多すぎるときは間引きます。
    const stars = state.stars.length > MAX_STARS
      ? state.stars.filter((_, i) => i % Math.ceil(state.stars.length / MAX_STARS) === 0)
      : state.stars;
    for (const s of stars) {
      if (!Number.isFinite(s.lat)) continue;
      const q = to(s);
      if (q.x < 0 || q.x > w || q.y < 0 || q.y > h) continue;
      let ph = phases.get(s);
      if (ph === undefined) { ph = random() * Math.PI * 2; phases.set(s, ph); }
      const tw = still ? 0.6 : 0.45 + 0.35 * Math.sin(now / 900 + ph);
      gfx.globalAlpha = tw;
      gfx.fillStyle = faint;
      gfx.beginPath();
      gfx.arc(q.x, q.y, 1.4, 0, Math.PI * 2);
      gfx.fill();
    }
    gfx.globalAlpha = 1;

    // 候補。絞られたぶんだけ明るく。
    for (const p of state.picks) {
      if (!Number.isFinite(p.lat)) continue;
      const q = to(p);
      gfx.fillStyle = teal;
      gfx.globalAlpha = 0.85;
      gfx.beginPath();
      gfx.arc(q.x, q.y, 3, 0, Math.PI * 2);
      gfx.fill();
    }
    gfx.globalAlpha = 1;

    // 試している順。planner が並べ替えを試すあいだ、線を引き直します。
    // 決まったら（route が入ったら）そちらを描きます。
    const line = state.route.length ? state.route : trial;
    if (line.length > 1) {
      const decided = state.route.length > 0;
      const prog = decided ? 1 : trialProgress;
      gfx.strokeStyle = decided ? ink : teal;
      gfx.lineWidth = decided ? 2.2 : 1.4;
      gfx.globalAlpha = decided ? 0.95 : 0.55;
      gfx.setLineDash(decided ? [] : [4, 5]);
      gfx.beginPath();
      const n = line.length;
      const upto = Math.max(1, Math.floor(prog * (n - 1)));
      for (let i = 0; i <= upto && i < n; i += 1) {
        const q = to(line[i]);
        if (i === 0) gfx.moveTo(q.x, q.y); else gfx.lineTo(q.x, q.y);
      }
      // 引きかけの先端は、次の点へ向かう途中まで。
      if (!decided && upto < n - 1) {
        const a = to(line[upto]);
        const c = to(line[upto + 1]);
        const f = prog * (n - 1) - upto;
        gfx.lineTo(a.x + (c.x - a.x) * f, a.y + (c.y - a.y) * f);
      }
      gfx.stroke();
      gfx.setLineDash([]);
      gfx.globalAlpha = 1;
      // 決まった順には、番号を打ちます。
      if (decided) {
        for (const [i, p] of line.entries()) {
          const q = to(p);
          gfx.fillStyle = ink;
          gfx.beginPath();
          gfx.arc(q.x, q.y, 5, 0, Math.PI * 2);
          gfx.fill();
          gfx.fillStyle = "#fff";
          gfx.font = "700 8px -apple-system, BlinkMacSystemFont, sans-serif";
          gfx.textAlign = "center";
          gfx.textBaseline = "middle";
          gfx.fillText(String(i + 1), q.x, q.y + 0.5);
        }
      }
    }

    // 出発地。輪が広がって、探しているところを示します。
    if (state.origin && Number.isFinite(state.origin.lat)) {
      const q = to(state.origin);
      if (q.x >= 0 && q.x <= w && q.y >= 0 && q.y <= h) {
        if (!still && state.step <= 1) {
          const r = 6 + ((now / 30) % 40);
          gfx.strokeStyle = ink;
          gfx.globalAlpha = Math.max(0, 1 - (r - 6) / 40) * 0.5;
          gfx.lineWidth = 1.2;
          gfx.beginPath();
          gfx.arc(q.x, q.y, r, 0, Math.PI * 2);
          gfx.stroke();
          gfx.globalAlpha = 1;
        }
        gfx.fillStyle = ink;
        gfx.beginPath();
        gfx.arc(q.x, q.y, 4, 0, Math.PI * 2);
        gfx.fill();
        gfx.strokeStyle = "#fff";
        gfx.lineWidth = 1.5;
        gfx.stroke();
      }
    }
  }

  /** 並べる順を、1つ試します（実際の planner と同じく、入れ替えです）。 */
  function newTrial(now) {
    const pool = state.picks.length ? state.picks : [];
    if (pool.length < 2) { trial = []; return; }
    const k = Math.min(6, pool.length);
    const idx = [...pool.keys()];
    // 種のある乱数で、毎回違う順を選びます。
    for (let i = idx.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    trial = idx.slice(0, k).map((i) => pool[i]);
    trialAt = now;
    trialProgress = 0;
  }

  /** 下の一言。収録の説明文から、そのまま。 */
  function tickCaption(now) {
    const pool = state.picks.length ? state.picks : state.stars;
    const withText = pool.filter((p) => p?.name && p?.description);
    if (!withText.length) {
      caption.textContent = state.step === 0
        ? "旅先の収録データを読んでいます"
        : "";
      return;
    }
    if (now - lastCaptionAt < CAPTION_MS && captionIdx >= 0) return;
    lastCaptionAt = now;
    captionIdx = (captionIdx + 1) % withText.length;
    const p = withText[captionIdx];
    const desc = String(p.description).replace(/\s+/g, " ").slice(0, 60);
    caption.textContent = `${p.name} — ${desc}`;
  }

  function loop() {
    if (stopped) return;
    if (!card.isConnected) { stop(); return; }
    const now = performance.now();
    // 星を取り直します。1.5秒に1回で足ります（読み込みはそれより遅い）。
    if (starsFn && now - starsAt > 1500) {
      starsAt = now;
      try {
        const got = starsFn();
        if (Array.isArray(got)) state.stars = got;
      } catch { /* 取れなければ、前のままで描きます */ }
    }
    if (!still) {
      // 試しの線は、2.6秒で引ききって、次を試します。
      if (!state.route.length && state.picks.length > 1) {
        if (!trial.length || now - trialAt > 2600) newTrial(now);
        trialProgress = Math.min(1, (now - trialAt) / 1800);
      }
    }
    draw(now);
    tickCaption(now);
    if (still) {
      // 動きを減らす設定。描き直すのは一言が変わるときだけで、
      // 5秒に1回で足ります。
      frame = setTimeout(loop, CAPTION_MS);
    } else {
      frame = requestAnimationFrame(loop);
    }
  }

  function stop() {
    stopped = true;
    if (still) clearTimeout(frame); else cancelAnimationFrame(frame);
    // 地図は自分で後片付けします。放っておくと、札が消えたあとも
    // タイルを取りに行き続けます。
    //
    // **すぐには消しません。** 寄せる動き（ズーム）の途中で remove() すると、
    // Leaflet 1.9.4 は動きの終わりの片付け（250ms 後のタイマー）を取り消さず、
    // 消えた地図を動かそうとして例外を出します（"_leaflet_pos" を読めない）。
    // 組み上がるのと寄せ直しが重なったときにだけ出るので、E2E が
    // ときどき落ちていました。動きを止め、その片付けが済んでから消します。
    const m = map;
    map = null;
    if (m) {
      try { m.stop(); } catch { /* 止める動きがありません */ }
      setTimeout(() => {
        try { m.remove(); } catch { /* もう消えています */ }
      }, MAP_SETTLE_MS);
    }
  }

  function update(patch) {
    const p = { ...(patch ?? {}) };
    if (typeof p.stars === "function") { starsFn = p.stars; delete p.stars; starsAt = 0; }
    Object.assign(state, p);
    if (p.picks && !still) newTrial(performance.now());
    if (still) draw(performance.now());
  }

  loop();
  return { update, stop };
}
