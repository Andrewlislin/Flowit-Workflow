# Permission-envelope replay

A retry with the same request ID and the same normalized input reuses the previously approved envelope. It does not repeat elicitation or Session provisioning. Any change to the goal, steps, working directory, Skills, model selection, or capabilities is a request-ID conflict and must use a new request ID.
