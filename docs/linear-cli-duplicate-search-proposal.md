# Add duplicate-candidate issue search with multi-query lexical union

## Summary

A single `linear issue list --query ... --json` call is not strong enough for duplicate detection recall when Japanese noun phrases, particles, spacing, or honorific differences are involved. The execution manager can compensate with query expansion on the repo side, but duplicate candidate search would be more reliable if the CLI could return the union of multiple queries directly.

## Proposed CLI Capability

- Accept multiple `--query` flags and return the union of their results in one JSON response
- Include `matchedQueries` and a lightweight score in the JSON payload
- Default to active/open issues only, while allowing an opt-in expansion to all states
- Ideally offer an optional CJK-friendly normalization mode that is robust to particle, honorific, and spacing differences

## Example Shape

```json
[
  {
    "identifier": "AIC-61",
    "title": "Invite Kakui-san to Kanazawa-san's ChatGPT project",
    "matchedQueries": [
      "kanazawa chatgpt project invite",
      "project invite"
    ],
    "score": 0.86
  }
]
```

## Why This Matters

- It becomes easier to catch near-duplicates such as `invite to Kanazawa-san's ChatGPT project` vs `have Kakui-san invited to Kanazawa-san's ChatGPT project`
- The repo no longer needs to call `issue list --query` repeatedly and then union/rank the results itself
- The CLI can return a more stable candidate set for fuzzy duplicates, not only exact duplicates
- Duplicate-candidate search becomes reusable across all CLI users, not only this manager runtime
