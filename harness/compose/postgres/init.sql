CREATE DATABASE harness_test;
-- LiteLLM keeps its own spend and budget tables. Without a database LiteLLM
-- does not enforce budgets at all, so the gateway gets one here.
CREATE DATABASE litellm;
