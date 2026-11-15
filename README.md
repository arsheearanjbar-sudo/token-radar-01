# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/arsheearanjbar-sudo/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/arsheearanjbar-sudo/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot, finds the protocols that record no token yet, ranks them by an implied launch value derived from the snapshot's own figures, and hands in an offline dashboard with a board, a detail view per protocol, filters, and a concrete farm plan for every row. The value model calibrates each category's multiple from the live-token protocols in the same snapshot, then weighs TVL, seven-day growth, time running with no token, and chain breadth. No protocol name is special-cased.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
```

Node.js 22.18 or later, standard library only, no network. The program writes `board.json`, `data.js`, `dashboard/`, `screenshots/`, and `dossier.json` to the output directory, deterministically: two runs write identical bytes.

## How it works

- `main.ts` — entrypoint: reads the snapshot, validates the board against the gate's rules, writes the outputs, and builds the dossier with `vendor/makefun-board.ts`.
- `lib/model.ts` — the model: watchlist coverage plus every other rankable pre-token protocol, calibrated category multiples, growth/maturity/chain multipliers, and farm plans derived from each protocol's category, chains, TVL, and age.
- `dashboard/` — a static offline page (`index.html`, `app.css`, `app.js`) that renders the board from `data.js`, with search, category and chain filters, a watchlist toggle, sortable columns, a live-token view kept apart from the ranking, and a detail view that recomputes each row and shows its farm plan verbatim.
- `screenshots/` — the board, a protocol's detail view, and a filtered view, captured from the dashboard itself.

Implied value is this entry's model, never a promise, and a ranked protocol records no token in the snapshot — the record is not proof it has none, and nothing here predicts whether or when a token is issued.

---

Entered on [make.fun](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards
