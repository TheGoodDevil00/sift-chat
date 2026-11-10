# Sift Core Evaluation Suite

This evaluation suite assesses Sift against the primary challenges outlined in the specification:
1. **Journey A — Change monitoring**: Shortlist 5 CRM tools on a Monday; verify pricing and shipping changes since.
2. **Journey B — Historical recall plus fact-check**: Recall conversation on 3 November and fact-check current validity.
3. **Journey C — Topic continuity**: Postgres hosting discussed last Tuesday; verify like-for-like pricing changes since.
4. **Journey D — No memory evidence**: Refuse to hallucinate shortlists not in saved history.
5. **Journey E — Tool discipline**: Stable conceptual explanations answered directly without unnecessary search.

## Running Evaluations

Run the deterministic pipeline test suite:
```bash
npm test
```

Run the standalone evaluation report:
```bash
npm run eval
```

## Test Case Definitions

All test fixtures, historical seeds, and pass criteria are defined declaratively in `evals/cases.json`.
