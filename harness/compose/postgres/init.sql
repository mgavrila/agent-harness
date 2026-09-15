CREATE DATABASE harness_test;
-- LiteLLM keeps its own spend and budget tables. Without a database LiteLLM
-- does not enforce budgets at all, so the gateway gets one here.
CREATE DATABASE litellm;
-- The eval runner truncates everything between cases; it must never be
-- pointed at a database anyone else is using.
CREATE DATABASE harness_evals;
