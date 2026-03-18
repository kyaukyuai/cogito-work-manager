# Task Intake Fixture

## Input

- originalRequest: `OPT社と金澤クローンAI開発の契約を締結する必要があります。`
- latestUserMessage: `ドラフト版作成後、OPT 田平さんに確認依頼する必要あり`
- combinedRequest:

```text
OPT社と金澤クローンAI開発の契約を締結する必要があります。
契約書のドラフト版の作成依頼済み
ドラフト版作成後、OPT 田平さんに確認依頼する必要あり
```

## Expected Reply

```json
{
  "action": "create",
  "planningReason": "complex-request",
  "parentTitle": "OPT社と金澤クローンAI開発の契約締結",
  "parentDueDate": null,
  "children": [
    {
      "title": "ドラフト作成",
      "kind": "execution",
      "dueDate": null
    },
    {
      "title": "OPT 田平さんへ契約書確認依頼",
      "kind": "execution",
      "dueDate": null,
      "assigneeHint": "OPT 田平さん"
    }
  ]
}
```
