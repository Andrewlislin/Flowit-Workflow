# Permission envelope failure matrix

| Failure | Required result |
| --- | --- |
| Elicitation unsupported | Reject before Adapter startup |
| User declines/cancels | No Session, intent, or Run |
| Approval response malformed | Reject and retain no grant |
| Grant input digest mismatch | Reject before Host call |
| Host reports broader or weaker policy | Archive managed Session and reject |
| Same request ID changes permissions | Conflict; never reprovision |
| Unattended node requests escalation | Decline and fail the node |
