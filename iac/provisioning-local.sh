#!/bin/bash -e

export AWS_PROFILE=emmaint-prod

_PULUMI_STATE_BUCKET=$(aws ssm get-parameter --name application-infrastructure-pulumi-state-bucket --query 'Parameter.Value' --output text)
_SOPS_FILE_PATH=secrets/$AWS_PROFILE.sops.yaml

pulumi login s3://"$_PULUMI_STATE_BUCKET"
sops exec-env "$_SOPS_FILE_PATH" "pulumi stack select $AWS_PROFILE-emma-motion-hotsite-sleep-conference"
sops exec-env "$_SOPS_FILE_PATH" "pulumi up"
