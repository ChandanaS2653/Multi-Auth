pipeline {
    agent any

    environment {
        APP_DIR          = '/opt/multiauth'
        APP_NAME         = 'multiauth'            // must match pm2.config.js name
        APP_PORT         = '5000'
        NODE_ENV         = 'production'
        // Health check parameters — explicit, not magic numbers
        HC_RETRIES       = '5'
        HC_WAIT_SECS     = '8'    // 5 * 8 = 40s max wait (Node startup is slower than Python)
        HC_TIMEOUT_SECS  = '5'
    }

    stages {

        // ── Stage 1: Pull latest code ────────────────────────────────────────
        stage('Checkout') {
            steps {
                script {
                    // Record schema hash BEFORE update so we can detect migration need
                    sh '''
                        if [ -f ${APP_DIR}/current/prisma/schema.prisma ]; then
                            sha256sum ${APP_DIR}/current/prisma/schema.prisma \
                                | awk '{print $1}' > /tmp/multiauth_schema_prev_hash
                        else
                            echo "none" > /tmp/multiauth_schema_prev_hash
                        fi
                    '''

                    // Record current commit for rollback before we pull
                    sh '''
                        if [ -d ${APP_DIR}/current/.git ]; then
                            git -C ${APP_DIR}/current rev-parse HEAD \
                                > /tmp/multiauth_prev_commit
                        else
                            echo "none" > /tmp/multiauth_prev_commit
                        fi
                    '''

                    checkout scm
                }
            }
        }

        // ── Stage 2: Install dependencies ────────────────────────────────────
        stage('Install') {
            steps {
                sh '''
                    set -e
                    # ci install: exact versions from package-lock.json, no updates
                    npm ci --omit=dev
                '''
            }
        }

        // ── Stage 3: Deploy ──────────────────────────────────────────────────
        // Runs migrations BEFORE touching the running app.
        // If migration fails, stage fails here — PM2 is never restarted against
        // a broken schema.
        stage('Deploy') {
            steps {
                withCredentials([
                    string(credentialsId: 'MULTIAUTH_DATABASE_URL',   variable: 'DATABASE_URL'),
                    string(credentialsId: 'MULTIAUTH_JWT_PRIVATE_KEY', variable: 'JWT_PRIVATE_KEY'),
                    string(credentialsId: 'MULTIAUTH_JWT_PUBLIC_KEY',  variable: 'JWT_PUBLIC_KEY'),
                    string(credentialsId: 'MULTIAUTH_HRM_CLIENT_ID',   variable: 'HRM_CLIENT_ID'),
                    string(credentialsId: 'MULTIAUTH_HRM_SECRET',      variable: 'HRM_CLIENT_SECRET'),
                    string(credentialsId: 'MULTIAUTH_CRM_CLIENT_ID',   variable: 'CRM_CLIENT_ID'),
                    string(credentialsId: 'MULTIAUTH_CRM_SECRET',      variable: 'CRM_CLIENT_SECRET'),
                    string(credentialsId: 'MULTIAUTH_CORS_ORIGIN',     variable: 'CORS_ORIGIN'),
                    string(credentialsId: 'MULTIAUTH_DOMAIN',          variable: 'DOMAIN'),
                ]) {
                    sh '''
                        set -e

                        # ── 1. Create timestamped release directory ──────────
                        RELEASE_DIR="${APP_DIR}/releases/$(date +%Y%m%d%H%M%S)"
                        mkdir -p "${RELEASE_DIR}"

                        # Copy workspace (code + node_modules from Install stage)
                        cp -r . "${RELEASE_DIR}/"

                        # ── 2. Write .env from Jenkins credentials ───────────
                        # Credentials never touch git — they are written only to
                        # the server's release directory with chmod 600.
                        cat > "${RELEASE_DIR}/.env" <<ENVEOF
DATABASE_URL=${DATABASE_URL}
DB_SSL=true
PORT=${APP_PORT}
NODE_ENV=${NODE_ENV}
DOMAIN=${DOMAIN}
JWT_PRIVATE_KEY=${JWT_PRIVATE_KEY}
JWT_PUBLIC_KEY=${JWT_PUBLIC_KEY}
JWT_ACCESS_TOKEN_EXPIRE=900
JWT_REFRESH_TOKEN_EXPIRE=604800
CORS_ORIGIN=${CORS_ORIGIN}
COOKIE_SAMESITE=strict
COOKIE_DOMAIN=${DOMAIN}
HRM_CLIENT_ID=${HRM_CLIENT_ID}
HRM_CLIENT_SECRET=${HRM_CLIENT_SECRET}
CRM_CLIENT_ID=${CRM_CLIENT_ID}
CRM_CLIENT_SECRET=${CRM_CLIENT_SECRET}
ENVEOF
                        chmod 600 "${RELEASE_DIR}/.env"
                        chown appuser:appuser "${RELEASE_DIR}/.env"

                        # ── 3. Generate Prisma client for this release ───────
                        cd "${RELEASE_DIR}"
                        DATABASE_URL="${DATABASE_URL}" npx prisma generate

                        # ── 4. Conditionally run migrations ─────────────────
                        # Compare current schema hash against the pre-pull hash.
                        # Migration runs if:
                        #   a) schema file changed (hash differs), OR
                        #   b) this is a first deploy (no prev hash recorded)
                        PREV_HASH=$(cat /tmp/multiauth_schema_prev_hash)
                        CURR_HASH=$(sha256sum prisma/schema.prisma | awk '{print $1}')

                        if [ "${PREV_HASH}" != "${CURR_HASH}" ]; then
                            echo "Prisma schema changed (${PREV_HASH} → ${CURR_HASH})"
                            echo "Running: npx prisma migrate deploy"
                            DATABASE_URL="${DATABASE_URL}" npx prisma migrate deploy
                            echo "Migrations applied successfully."
                        else
                            echo "Prisma schema unchanged — skipping migration."
                        fi

                        # Save new schema hash for next run
                        echo "${CURR_HASH}" > /tmp/multiauth_schema_prev_hash

                        # ── 5. Atomically switch to new release ──────────────
                        ln -sfn "${RELEASE_DIR}" ${APP_DIR}/current

                        # ── 6. Start or reload PM2 process ───────────────────
                        # 'reload' does a rolling restart (zero-downtime).
                        # Falls back to 'start' if the app isn't running yet.
                        cd ${APP_DIR}/current

                        if pm2 show ${APP_NAME} > /dev/null 2>&1; then
                            pm2 reload pm2.config.js --env production --update-env
                        else
                            pm2 start pm2.config.js --env production
                            pm2 save  # persist process list across server reboots
                        fi
                    '''
                }
            }
        }

        // ── Stage 4: Health Check ─────────────────────────────────────────────
        // Checks HTTP 200 AND success:true in JSON body.
        // /  (root) returns {"success":true,"message":"System Works"} — used as
        // the health signal since the app has no dedicated /health route.
        stage('Health Check') {
            steps {
                script {
                    def healthy = false
                    def retries = env.HC_RETRIES.toInteger()
                    def waitSecs = env.HC_WAIT_SECS.toInteger()
                    def timeoutSecs = env.HC_TIMEOUT_SECS.toInteger()

                    for (int i = 1; i <= retries; i++) {
                        echo "Health check attempt ${i}/${retries}..."
                        def result = sh(
                            script: """
                                set -e
                                STATUS=\$(curl -s -o /tmp/multiauth_hc.json -w '%{http_code}' \\
                                    --max-time ${timeoutSecs} \\
                                    http://localhost:${env.APP_PORT}/)

                                SUCCESS=\$(node -e "
                                    try {
                                        const d = require('/tmp/multiauth_hc.json');
                                        process.exit(d.success === true ? 0 : 1);
                                    } catch(e) { process.exit(1); }
                                ")

                                echo "HTTP \${STATUS} | success field: \${SUCCESS:-checked via exit code}"
                                [ "\${STATUS}" = "200" ]
                            """,
                            returnStatus: true
                        )
                        if (result == 0) {
                            echo "Health check passed on attempt ${i}."
                            healthy = true
                            break
                        }
                        if (i < retries) {
                            echo "Not healthy yet, waiting ${waitSecs}s..."
                            sleep(waitSecs)
                        }
                    }

                    if (!healthy) {
                        error("Health check failed after ${retries} attempts — triggering rollback.")
                    }
                }
            }
        }
    }

    post {
        failure {
            script {
                echo "Pipeline failed — attempting rollback..."
                sh '''
                    set -e

                    PREV_COMMIT=$(cat /tmp/multiauth_prev_commit 2>/dev/null || echo "none")

                    if [ "${PREV_COMMIT}" = "none" ]; then
                        echo "No previous commit recorded — cannot rollback. Manual intervention required."
                        exit 0
                    fi

                    # Find the release directory matching the previous commit
                    PREV_RELEASE=$(find ${APP_DIR}/releases -maxdepth 1 -type d \
                        -exec sh -c 'git -C "$1" rev-parse HEAD 2>/dev/null' _ {} \; \
                        -print | grep -B1 "${PREV_COMMIT}" | head -1)

                    if [ -n "${PREV_RELEASE}" ] && [ -d "${PREV_RELEASE}" ]; then
                        echo "Rolling back to release: ${PREV_RELEASE}"
                        ln -sfn "${PREV_RELEASE}" ${APP_DIR}/current
                        cd ${APP_DIR}/current
                        pm2 reload pm2.config.js --env production --update-env
                        echo "Rollback complete. App restored to previous release."
                    else
                        echo "Previous release directory not found — manual intervention required."
                    fi
                '''
            }
        }
        success {
            sh '''
                # Keep only the 5 most recent releases — clean up old ones
                ls -dt ${APP_DIR}/releases/*/ | tail -n +6 | xargs rm -rf || true
            '''
            echo "Deployment successful. Multi-Auth running on port ${APP_PORT}."
        }
    }
}
