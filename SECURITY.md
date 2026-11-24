# Security

Please do not report security problems in public issues. Email support@horseup.de with "hu-mm-av security" in the subject, and include steps to reproduce. We aim to reply within a week.

The plugin sends audio chunks only to the Amazon Bedrock region you configure. It never logs audio or transcripts, and the AWS key needs only `bedrock:InvokeModel` on the one model (see the README).
