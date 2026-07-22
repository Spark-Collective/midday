-- Background-job failure alerts (spark): the hourly job-health-check sweep
-- writes activities of this type. NB: ALTER TYPE ... ADD VALUE cannot run
-- inside a transaction block — apply this file standalone, no BEGIN.
ALTER TYPE "activity_type" ADD VALUE IF NOT EXISTS 'job_failed';
