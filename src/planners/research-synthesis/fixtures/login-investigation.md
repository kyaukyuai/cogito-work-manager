# Research Synthesis Fixture

## Input

- taskTitle: `ログイン画面の不具合調査`
- sourceMessage: `ログイン画面の不具合を調査して`
- relatedIssuesSummary: `- AIC-11 / ログイン画面の不具合修正 / Started`

## Expected Reply

```json
{
  "findings": ["関連 issue を確認しました。"],
  "uncertainties": ["対処方針の確定が必要です。"],
  "nextActions": [
    {
      "title": "API 仕様の確認",
      "purpose": "仕様差分を確認する",
      "confidence": 0.8
    },
    {
      "title": "修正方針の整理",
      "purpose": "方針を整理する",
      "confidence": 0.7
    }
  ]
}
```
