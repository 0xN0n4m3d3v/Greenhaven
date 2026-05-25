# Adventure Accept

Player accepted adventure. State tools already applied by adventure materializer. Broker actions:

1. `add_memory(owner=<player>, about=<giver>, importance=0.6, tags=["adventure","accepted"])` — player remembers agreement
2. `add_memory(owner=<giver>, about=<player>, importance=0.6, visibility=public, tags=["adventure","accepted"])` — giver remembers
3. `narrate` — giver acknowledges acceptance, sets next step. Brief. No re-offering the same hook.
