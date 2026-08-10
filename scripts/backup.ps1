# Everything remaude and Claude Code keep on this machine, copied to S3.
#
# What is actually irreplaceable lives in two folders and nowhere else: the
# transcripts of every conversation (~/.claude/projects) and remaude's own
# bookkeeping (~/.remaude) -- the inbox index, chat threads, read marks, drafts.
# Neither is in any repository. A dead disk takes both.
#
# Keys and logs are left behind on purpose: a backup should not be a place where
# a private key ends up.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1            # copy now
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -Install   # and every day from now on
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 -Restore   # bring it back
param(
  [switch]$Install,
  [switch]$Restore,
  [string]$Bucket = $env:REMAUDE_BACKUP_BUCKET
)
$ErrorActionPreference = 'Stop'

$home_ = $env:USERPROFILE
$transcripts = Join-Path $home_ '.claude\projects'
$state = Join-Path $home_ '.remaude'
$region = if ($env:REMAUDE_AWS_REGION) { $env:REMAUDE_AWS_REGION } else { aws configure get region }
if (-not $region) { $region = 'eu-west-3' }

if (-not $Bucket) {
  # one bucket per account, so the name is the same on every machine of this person
  $account = (aws sts get-caller-identity --output json | ConvertFrom-Json).Account
  if (-not $account) { throw 'aws cli is not signed in -- run `aws configure` first' }
  $Bucket = "remaude-backup-$account"
}

# json for the aws cli goes through a file: powershell strips the quotes out of
# an argument on its way to a native program, and the cli then sees no json at all
function Send-Json($json) {
  $file = Join-Path $env:TEMP ('remaude-aws-' + [guid]::NewGuid().ToString('N') + '.json')
  [IO.File]::WriteAllText($file, $json, [Text.UTF8Encoding]::new($false))
  return 'file://' + $file.Replace('\', '/')
}

function Ensure-Bucket {
  $exists = $true
  try { aws s3api head-bucket --bucket $Bucket 2>$null } catch { $exists = $false }
  if (-not $?) { $exists = $false }

  if (-not $exists) {
    Write-Host "creating s3://$Bucket in $region"
    if ($region -eq 'us-east-1') {
      aws s3api create-bucket --bucket $Bucket --region $region | Out-Null
    } else {
      aws s3api create-bucket --bucket $Bucket --region $region --create-bucket-configuration "LocationConstraint=$region" | Out-Null
    }
  }

  # applied every run rather than at creation: settings that protect a copy of
  # someone's whole working life should not depend on one lucky first attempt
  aws s3api put-public-access-block --bucket $Bucket --public-access-block-configuration `
    'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true' | Out-Null
  aws s3api put-bucket-encryption --bucket $Bucket --server-side-encryption-configuration `
    (Send-Json '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}') | Out-Null
  # a file deleted here is kept for a month, in case the deletion was the mistake
  aws s3api put-bucket-versioning --bucket $Bucket --versioning-configuration 'Status=Enabled' | Out-Null
  aws s3api put-bucket-lifecycle-configuration --bucket $Bucket --lifecycle-configuration `
    (Send-Json '{"Rules":[{"ID":"expire-old-versions","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":30}}]}') | Out-Null
}

# Left behind: the ssh key to the relay, the oauth secret, logs that regrow by
# themselves. Everything else in that folder is worth having back.
$stateExcludes = @('--exclude', '*.pem', '--exclude', '*oauth*', '--exclude', '*.log', '--exclude', 'uploads/*')

if ($Restore) {
  Write-Host "restoring from s3://$Bucket -- existing files are kept, missing ones come back"
  aws s3 sync "s3://$Bucket/claude-projects" $transcripts
  aws s3 sync "s3://$Bucket/remaude" $state
  Write-Host 'done -- restart the host to pick it up'
  return
}

if ($Install) {
  $task = 'remaude backup'
  $me = $MyInvocation.MyCommand.Path
  $command = 'powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $me + '"'
  schtasks /Create /TN $task /TR $command /SC DAILY /ST 04:30 /F | Out-Null
  Write-Host "scheduled: it runs every day at 04:30"
}

Ensure-Bucket
$started = Get-Date
aws s3 sync $transcripts "s3://$Bucket/claude-projects" --only-show-errors
aws s3 sync $state "s3://$Bucket/remaude" @stateExcludes --only-show-errors

$size = (aws s3 ls "s3://$Bucket" --recursive --summarize | Select-String 'Total Size:') -replace '.*:\s*', ''
$took = [int]((Get-Date) - $started).TotalSeconds
$megabytes = [int]([double]$size / 1MB)
Write-Host "backed up to s3://$Bucket in ${took}s -- $megabytes MB there now"
$stamp = (Get-Date).ToString('u')
"$stamp ok ${took}s ${megabytes}MB" | Add-Content (Join-Path $state 'backup.log')
