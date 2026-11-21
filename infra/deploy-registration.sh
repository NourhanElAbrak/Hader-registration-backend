#!/usr/bin/env bash
# Deploys the Workshop & Registration Service to Floci (local AWS), following Lab 7:
#   IAM role -> Lambda function -> API Gateway (HTTP API) -> website on S3.
# Run it from the HaderApp folder in Git Bash:   bash infra/deploy-registration.sh
# Safe to run again: it updates what already exists instead of creating it twice.
set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-floci}" AWS_PAGER="" MSYS_NO_PATHCONV=1
ACCOUNT="${ACCOUNT:-000000000000}"
REGION="us-east-1"
FN="hader-registration-api"
ROLE="hader-registration-role"
POLICY="hader-registration-logs"
API_NAME="hader-http-api"
BUCKET="hader-web"
SITE_ORIGIN="${SITE_ORIGIN:-http://localhost:4566}"
SERVICE="services/registration"
BUILD="infra/.site-build"

step() { echo; echo "== $1"; }
none() { [ -z "$1" ] || [ "$1" = "None" ]; }

[ -f "$SERVICE/.env" ] || { echo "Run this from the HaderApp folder ($SERVICE/.env not found)."; exit 1; }

step "1/6 Check that we are talking to Floci"
acct=$(aws sts get-caller-identity --query Account --output text)
if [ "$acct" != "$ACCOUNT" ]; then
  echo "Account is $acct, expected $ACCOUNT. Run: export AWS_PROFILE=floci"; exit 1
fi
echo "OK, account $acct"

step "2/6 IAM role: the function may only write its own logs (least privilege)"
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document file://infra/iam/lambda-trust-policy.json \
    --query Role.Arn --output text
else
  echo "Role $ROLE already exists"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$POLICY" \
  --policy-document file://infra/iam/registration-logs-policy.json
echo "Policy $POLICY attached"

step "3/6 Build lambda.zip and create or update the Lambda function"
(cd "$SERVICE" && npm install --silent && npm run zip)
ENV_JSON=$(cd "$SERVICE" && node scripts/lambda-env.js "$SITE_ORIGIN,http://localhost:8080")

if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" \
    --zip-file "fileb://$SERVICE/lambda.zip" --query LastModified --output text
  aws lambda wait function-updated-v2 --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" \
    --environment "$ENV_JSON" --timeout 15 --query LastModified --output text
  aws lambda wait function-updated-v2 --function-name "$FN"
else
  aws lambda create-function --function-name "$FN" \
    --runtime nodejs24.x --handler lambda.handler \
    --role "arn:aws:iam::$ACCOUNT:role/$ROLE" \
    --zip-file "fileb://$SERVICE/lambda.zip" --timeout 15 --memory-size 256 \
    --environment "$ENV_JSON" --query FunctionArn --output text
  aws lambda wait function-active-v2 --function-name "$FN"
fi
rm -f "$SERVICE/lambda.zip"
echo "Function $FN is ready"

step "4/6 API Gateway: one HTTP API, only the routes this service needs"
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text)
if none "$API_ID"; then
  API_ID=$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP --query ApiId --output text)
fi
FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN"
INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$FN_ARN'].IntegrationId | [0]" --output text)
if none "$INTEGRATION_ID"; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --payload-format-version 2.0 \
    --integration-uri "$FN_ARN" --query IntegrationId --output text)
fi

ROUTES=(
  "GET /health"
  "GET /me"
  "GET /workshops"
  "POST /workshops"
  "PUT /workshops/{id}"
  "POST /workshops/{id}/registrations"
  "GET /workshops/{id}/registrations"
  "GET /registrations/me"
  "DELETE /registrations/{id}"
  "OPTIONS /me"
  "OPTIONS /workshops"
  "OPTIONS /workshops/{id}"
  "OPTIONS /workshops/{id}/registrations"
  "OPTIONS /registrations/me"
  "OPTIONS /registrations/{id}"
)
EXISTING=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" --output text | tr '\t' '\n')
for ROUTE in "${ROUTES[@]}"; do
  if printf '%s\n' "$EXISTING" | grep -qxF "$ROUTE"; then
    echo "  route exists: $ROUTE"
  else
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$ROUTE" \
      --target "integrations/$INTEGRATION_ID" --query RouteKey --output text | sed 's/^/  route added: /'
  fi
done

if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' >/dev/null 2>&1; then
  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy >/dev/null
fi
if aws apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
     --default-route-settings ThrottlingBurstLimit=20,ThrottlingRateLimit=10 >/dev/null 2>&1; then
  echo "Throttling on: 10 requests per second, bursts of 20 (extra requests get 429)"
else
  echo "Throttling: not supported by this Floci version (it is set on real AWS)"
fi

if aws lambda add-permission --function-name "$FN" --statement-id apigw-invoke \
     --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
     --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" >/dev/null 2>&1; then
  echo "API Gateway may now call $FN (and nobody else may)"
else
  echo "Permission for API Gateway already exists"
fi
API_URL="http://$API_ID.execute-api.localhost.floci.io:4566"

step "5/6 Website on S3 (frontend files only: never .env or backend code)"
aws s3 mb "s3://$BUCKET" >/dev/null 2>&1 || true
rm -rf "$BUILD"
mkdir -p "$BUILD"
cp -r frontend/. "$BUILD/"
rm -rf "$BUILD/node_modules" "$BUILD/package.json" "$BUILD/package-lock.json"
sed -i "s#REGISTRATION_API: '[^']*'#REGISTRATION_API: '$API_URL'#" "$BUILD/shared/config.js"
aws s3 rm "s3://$BUCKET" --recursive >/dev/null
aws s3 cp "$BUILD" "s3://$BUCKET" --recursive --exclude "*" --include "*.html" --content-type text/html --only-show-errors
aws s3 cp "$BUILD" "s3://$BUCKET" --recursive --exclude "*" --include "*.css" --content-type text/css --only-show-errors
aws s3 cp "$BUILD" "s3://$BUCKET" --recursive --exclude "*" --include "*.js" --content-type text/javascript --only-show-errors
rm -rf "$BUILD"
aws s3 ls "s3://$BUCKET" --recursive | awk '{print "  " $4}'

step "6/6 Quick test"
echo "GET $API_URL/health"
curl -s -m 30 "$API_URL/health" || echo "(no answer yet: wait 30 seconds and try again)"
echo
echo
echo "Done."
echo "  API:      $API_URL"
echo "  Website:  $SITE_ORIGIN/$BUCKET/index.html"
echo "  Logs:     aws logs tail /aws/lambda/$FN --since 15m --format short"
