# Follow-up Resolution Fixture

## Input

- issueId: `AIC-123`
- issueTitle: `ログイン画面の不具合修正`
- requestKind: `blocked-details`
- requestText: `原因と、誰の返答待ちか、何がそろえば再開できるかを共有してください。`

## Expected Reply

```json
{
  "answered": true,
  "answerKind": "blocked-details",
  "confidence": 0.9,
  "extractedFields": {
    "blockedReason": "API 仕様差分",
    "waitingOn": "田平さん",
    "resumeCondition": "仕様確定"
  },
  "reasoningSummary": "要求された blocked 詳細を満たしています。"
}
```
