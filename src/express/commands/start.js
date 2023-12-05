// noinspection JSCheckFunctionSignatures,JSUnresolvedFunction,JSUnresolvedVariable

import {
  validateConfigs,
  editMaticCliDockerYAMLConfig,
  editMaticCliRemoteYAMLConfig,
  getDevnetId,
  splitAndGetHostIp,
  splitToArray,
  setBorAndErigonHosts
} from '../common/config-utils'
import {
  maxRetries,
  runScpCommand,
  runSshCommand
} from '../common/remote-worker'
import { timer } from '../common/time-utils'
import yaml from 'js-yaml'
import fs from 'fs'

const shell = require('shelljs')

async function terraformApply(devnetId) {
  console.log('📍Executing terraform apply...')
  shell.exec(
    `terraform -chdir=../../deployments/devnet-${devnetId} apply -auto-approve -var-file=./secret.tfvars`,
    {
      env: {
        ...process.env
      }
    }
  )
}

async function terraformOutput() {
  console.log('📍Executing terraform output...')
  const { stdout } = shell.exec('terraform output --json', {
    env: {
      ...process.env
    }
  })

  return stdout
}

async function installRequiredSoftwareOnRemoteMachines(
  ips,
  devnetType,
  devnetId
) {
  const doc = await yaml.load(
    fs.readFileSync(
      `../../deployments/devnet-${devnetId}/${devnetType}-setup-config.yaml`,
      'utf8'
    )
  )

  const ipsArray = splitToArray(ips)
  let borUsers = []
  let erigonUsers = []
  if (doc.devnetBorUsers) {
    borUsers = splitToArray(doc.devnetBorUsers.toString())
  }
  if (doc.devnetErigonUsers) {
    erigonUsers = splitToArray(doc.devnetErigonUsers.toString())
  }
  let user, ip
  const nodeIps = []
  const isHostMap = new Map()

  for (let i = 0; i < ipsArray.length; i++) {
    /* eslint-disable */
    i === 0
      ? (user = `${doc.ethHostUser}`)
      : i >= borUsers.length
      ? (user = `${erigonUsers[i - borUsers.length]}`)
      : (user = `${borUsers[i]}`)
    ip = `${user}@${ipsArray[i]}`
    nodeIps.push(ip)
    /* eslint-disable */

    i === 0 ? isHostMap.set(ip, true) : isHostMap.set(ip, false)
  }

  const requirementTasks = nodeIps.map(async (ip) => {
    user = splitAndGetHostIp(ip)
    // FIXME re-enable when fixed
    // await keepSshConfigAlive(ip)
    await configureCertAndPermissions(user, ip)
    await installCommonPackages(ip)

    if (isHostMap.get(ip)) {
      // Install Host dependencies
      await installHostSpecificPackages(ip)

      if (process.env.TF_VAR_DOCKERIZED === 'yes') {
        await installDocker(ip, user)
      }
    }
  })

  await Promise.all(requirementTasks)
}

async function keepSshConfigAlive(ip) {
  console.log('📍Modifying ssh config in instance...')
  const config = `TCPKeepAlive no
  ClientAliveInterval 30
  ClientAliveCountMax 240`

  // FIXME
  //  maybe we need to check the config before restarting the service?
  //  try `sshd -t`
  //  Also, is this needed at all? Setting it every time from client
  //  should let us achieve the same result (avoiding server side changes)
  //  see https://www.simplified.guide/ssh/disable-timeout
  let command = `sudo sh -c 'cat << EOF >> /etc/ssh/sshd_config
  ${config}'`

  await runSshCommand(ip, command, maxRetries)

  //  FIXME
  //   runSshCommand requires sshd connection
  //   despite that, restarting sshd won't disconnect the current session
  //   hence - theoretically - the following command is fine
  console.log('📍Restarting ssh service...')
  command = 'sudo systemctl restart ssh'
  await runSshCommand(ip, command, maxRetries)

  // FIXME
  //  another issue might be that the method keepSshConfigAlive
  //  is being called in as a requirement task in Promise.all(requirementTasks)
  //  hence several ssh connections to the same machine
  //  might be running in parallel (?)
  //  this could potentially make the ssh restart fail
}

async function configureCertAndPermissions(user, ip) {
  console.log('📍Allowing user not to use password...')
  let command = `echo "${user} ALL=(ALL) NOPASSWD:ALL" | sudo tee -a /etc/sudoers`
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Give permissions to all users for root folder...')
  command = 'sudo chmod 755 -R ~/'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Copying certificate to ' + ip + ':~/cert.pem...')
  const src = `${process.env.PEM_FILE_PATH}`
  const dest = `${ip}:~/cert.pem`
  await runScpCommand(src, dest, maxRetries)

  console.log('📍Adding ssh for ' + ip + ':~/cert.pem...')
  command =
    'sudo chmod 700 ~/cert.pem && eval "$(ssh-agent -s)" && ssh-add ~/cert.pem && sudo chmod -R 700 ~/.ssh'
  await runSshCommand(ip, command, maxRetries)
}

async function installCommonPackages(ip) {
  console.log('📍Installing required software on remote machine ' + ip + '...')

  console.log('📍Running apt update...')
  let command = 'sudo apt update -y'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing build-essential...')
  command = 'sudo apt install build-essential -y'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing jq...')
  command = 'sudo apt install jq -y'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing go...')
  command = `wget -nc https://raw.githubusercontent.com/maticnetwork/node-ansible/master/go-install.sh &&
                         bash go-install.sh --remove &&
                         bash go-install.sh &&
                         source ~/.bashrc`
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Creating symlink for go...')
  command = 'sudo ln -sf ~/.go/bin/go /usr/local/bin/go'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing rabbitmq...')
  command = 'sudo apt install rabbitmq-server -y'
  await runSshCommand(ip, command, maxRetries)
}

async function installHostSpecificPackages(ip) {
  console.log('📍Installing nvm...')
  let command = `curl https://raw.githubusercontent.com/creationix/nvm/master/install.sh | bash &&
                        export NVM_DIR="$HOME/.nvm"
                        [ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
                        [ -s "$NVM_DIR/bash_completion" ] && \\. "$NVM_DIR/bash_completion" && 
                        nvm install 16.20.2`
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing solc...')
  command = 'sudo snap install solc'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing python2...')
  command = 'sudo apt install python2 -y && alias python="/usr/bin/python2"'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing nodejs and npm...')
  command = 'sudo apt install nodejs npm -y'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Creating symlink for npm and node...')
  command = `sudo ln -sf ~/.nvm/versions/node/v16.20.2/bin/npm /usr/bin/npm &&
                    sudo ln -sf ~/.nvm/versions/node/v16.20.2/bin/node /usr/bin/node &&
                    sudo ln -sf ~/.nvm/versions/node/v16.20.2/bin/npx /usr/bin/npx`
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing ganache...')
  command = 'sudo npm install -g ganache -y'
  await runSshCommand(ip, command, maxRetries)
}

export async function installDocker(ip, user) {
  console.log('📍Setting docker repository up...')
  let command =
    'sudo apt-get update -y && sudo apt install apt-transport-https ca-certificates curl software-properties-common -y'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing docker...')
  command =
    'curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -'
  await runSshCommand(ip, command, maxRetries)
  command =
    'sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu focal stable"'
  await runSshCommand(ip, command, maxRetries)
  command = 'sudo apt install docker-ce docker-ce-cli containerd.io -y'
  await runSshCommand(ip, command, maxRetries)
  command = 'sudo apt install docker-compose-plugin -y'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Adding user to docker group...')
  command = `sudo usermod -aG docker ${user}`
  await runSshCommand(ip, command, maxRetries)
}

async function prepareMaticCLI(ips, devnetType, devnetId) {
  const doc = await yaml.load(
    fs.readFileSync(
      `../../deployments/devnet-${devnetId}/${devnetType}-setup-config.yaml`,
      'utf8'
    )
  )
  const ipsArray = splitToArray(ips)
  const ip = `${doc.ethHostUser}@${ipsArray[0]}`

  const maticCliRepo = process.env.MATIC_CLI_REPO
  const maticCliBranch = process.env.MATIC_CLI_BRANCH

  console.log('📍Git clone ' + maticCliRepo + ' if does not exist on ' + ip)
  let command = `cd ~ && git clone ${maticCliRepo} || (cd ~/matic-cli; git fetch)`
  await runSshCommand(ip, command, maxRetries)

  console.log(
    '📍Git checkout ' + maticCliBranch + ' and git pull on machine ' + ip
  )
  command = `cd ~/matic-cli && git checkout ${maticCliBranch} && git pull || (cd ~/matic-cli && git stash && git stash drop && git pull)`
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Installing matic-cli dependencies...')
  command = 'cd ~/matic-cli && npm i'
  await runSshCommand(ip, command, maxRetries)
}

async function eventuallyCleanupPreviousDevnet(ips, devnetType, devnetId) {
  const doc = await yaml.load(
    fs.readFileSync(
      `../../deployments/devnet-${devnetId}/${devnetType}-setup-config.yaml`,
      'utf8'
    )
  )

  const ipsArray = splitToArray(ips)
  let borUsers = []
  let erigonUsers = []
  if (doc.devnetBorUsers) {
    borUsers = splitToArray(doc.devnetBorUsers.toString())
  }
  if (doc.devnetErigonUsers) {
    erigonUsers = splitToArray(doc.devnetErigonUsers.toString())
  }
  let user, ip
  const nodeIps = []
  const isHostMap = new Map()

  for (let i = 0; i < ipsArray.length; i++) {
    /* eslint-disable */
    i === 0
      ? (user = `${doc.ethHostUser}`)
      : i >= borUsers.length
      ? (user = `${erigonUsers[i - borUsers.length]}`)
      : (user = `${borUsers[i]}`)
    ip = `${user}@${ipsArray[i]}`
    nodeIps.push(ip)
    /* eslint-disable */
    i === 0 ? isHostMap.set(ip, true) : isHostMap.set(ip, false)
  }

  const cleanupTasks = nodeIps.map(async (ip) => {
    if (isHostMap.get(ip)) {
      // Cleanup Host
      console.log(
        '📍Removing old devnet (if present) on machine ' + ip + ' ...'
      )
      let command = 'sudo rm -rf ~/matic-cli/devnet'
      await runSshCommand(ip, command, maxRetries)

      console.log('📍Stopping ganache (if present) on machine ' + ip + ' ...')
      command =
        "sudo systemctl stop ganache.service || echo 'ganache not running on current machine...'"
      await runSshCommand(ip, command, maxRetries)
    }
    console.log('📍Stopping heimdall (if present) on machine ' + ip + ' ...')
    let command =
      "sudo systemctl stop heimdalld.service || echo 'heimdall not running on current machine...'"
    await runSshCommand(ip, command, maxRetries)

    console.log('📍Stopping bor (if present) on machine ' + ip + ' ...')
    command =
      "sudo systemctl stop bor.service || echo 'bor not running on current machine...'"
    await runSshCommand(ip, command, maxRetries)

    console.log('📍Stopping erigon (if present) on machine ' + ip + ' ...')
    command =
      "sudo systemctl stop erigon.service || echo 'erigon not running on current machine...'"
    await runSshCommand(ip, command, maxRetries)

    console.log('📍Removing .bor folder (if present) on machine ' + ip + ' ...')
    command = 'sudo rm -rf ~/.bor'
    await runSshCommand(ip, command, maxRetries)

    console.log(
      '📍Removing /var/lib/heimdall folder (if present) on machine ' +
        ip +
        ' ...'
    )
    command = 'sudo rm -rf /var/lib/heimdall'
    await runSshCommand(ip, command, maxRetries)

    console.log('📍Removing data folder (if present) on machine ' + ip + ' ...')
    command = 'sudo rm -rf ~/data'
    await runSshCommand(ip, command, maxRetries)

    console.log('📍Removing node folder (if present) on machine ' + ip + ' ...')
    command = 'sudo rm -rf ~/node'
    await runSshCommand(ip, command, maxRetries)
  })

  await Promise.all(cleanupTasks)
}

async function runDockerSetupWithMaticCLI(ips, devnetId) {
  const doc = await yaml.load(
    fs.readFileSync(
      `../../deployments/devnet-${devnetId}/docker-setup-config.yaml`,
      'utf8'
    )
  )
  const ipsArray = splitToArray(ips)
  const ip = `${doc.ethHostUser}@${ipsArray[0]}`

  console.log('📍Creating devnet and removing default configs...')
  let command =
    'cd ~/matic-cli && mkdir -p devnet && rm configs/devnet/docker-setup-config.yaml'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Copying docker matic-cli configurations...')
  const src = `../../deployments/devnet-${devnetId}/docker-setup-config.yaml`
  const dest = `${doc.ethHostUser}@${ipsArray[0]}:~/matic-cli/configs/devnet/docker-setup-config.yaml`
  await runScpCommand(src, dest, maxRetries)

  console.log('📍Executing docker setup with matic-cli...')
  command =
    'cd ~/matic-cli/devnet && ../bin/matic-cli setup devnet -c ../configs/devnet/docker-setup-config.yaml'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Starting ganache...')
  command = 'cd ~/matic-cli/devnet && bash docker-ganache-start.sh'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Starting heimdall...')
  command = 'cd ~/matic-cli/devnet && bash docker-heimdall-start-all.sh'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Setting up bor...')
  command = 'cd ~/matic-cli/devnet && bash docker-bor-setup.sh'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Starting bor...')
  command = 'cd ~/matic-cli/devnet && bash docker-bor-start-all.sh'
  await runSshCommand(ip, command, maxRetries)

  if (!process.env.NETWORK) {
    await timer(60000)
    console.log('📍Deploying contracts for bor...')
    command = 'cd ~/matic-cli/devnet && bash ganache-deployment-bor.sh'
    await runSshCommand(ip, command, maxRetries)

    await timer(60000)
    console.log('📍Deploying state-sync contracts...')
    command = 'cd ~/matic-cli/devnet && bash ganache-deployment-sync.sh'
    await runSshCommand(ip, command, maxRetries)
  }

  await timer(60000)
  console.log('📍Executing bor ipc tests...')
  console.log('📍1. Fetching admin.peers...')
  command =
    'cd ~/matic-cli/devnet && docker exec bor0 bash -c "bor attach /root/.bor/data/bor.ipc -exec \'admin.peers\'"'
  await runSshCommand(ip, command, maxRetries)
  console.log('📍2. Fetching eth.blockNumber...')
  command =
    'cd ~/matic-cli/devnet && docker exec bor0 bash -c "bor attach /root/.bor/data/bor.ipc -exec \'eth.blockNumber\'"'
  await runSshCommand(ip, command, maxRetries)
  console.log('📍bor ipc tests executed...')
}

async function runRemoteSetupWithMaticCLI(ips, devnetId) {
  const doc = await yaml.load(
    fs.readFileSync(
      `../../deployments/devnet-${devnetId}/remote-setup-config.yaml`,
      'utf8'
    )
  )
  const ipsArray = splitToArray(ips)
  const ip = `${doc.ethHostUser}@${ipsArray[0]}`

  console.log('📍Creating devnet and removing default configs...')
  let command =
    'cd ~/matic-cli && mkdir -p devnet && rm configs/devnet/remote-setup-config.yaml'
  await runSshCommand(ip, command, maxRetries)

  console.log('📍Copying remote matic-cli configurations...')
  const src = `../../deployments/devnet-${devnetId}/remote-setup-config.yaml`
  const dest = `${doc.ethHostUser}@${ipsArray[0]}:~/matic-cli/configs/devnet/remote-setup-config.yaml`
  await runScpCommand(src, dest, maxRetries)

  console.log('📍Executing remote setup with matic-cli...')
  command =
    'cd ~/matic-cli/devnet && ../bin/matic-cli setup devnet -c ../configs/devnet/remote-setup-config.yaml'
  await runSshCommand(ip, command, maxRetries)

  if (!process.env.NETWORK) {
    console.log('📍Deploying contracts for bor on machine ' + ip + ' ...')
    await timer(60000)
    command = 'cd ~/matic-cli/devnet && bash ganache-deployment-bor.sh'
    await runSshCommand(ip, command, maxRetries)

    console.log('📍Deploying state-sync contracts on machine ' + ip + ' ...')
    await timer(60000)
    command = 'cd ~/matic-cli/devnet && bash ganache-deployment-sync.sh'
    await runSshCommand(ip, command, maxRetries)
  }
}

export async function start() {
  const devnetId = getDevnetId()
  require('dotenv').config({ path: `${process.cwd()}/.env` })

  shell.exec(`terraform workspace select devnet-${devnetId}`)

  const devnetType =
    process.env.TF_VAR_DOCKERIZED === 'yes' ? 'docker' : 'remote'

  await terraformApply(devnetId)
  const tfOutput = await terraformOutput()
  let dnsIps = JSON.parse(tfOutput).instance_dns_ips.value.toString()
  const ids = JSON.parse(tfOutput).instance_ids.value.toString()
  const cloud = JSON.parse(tfOutput).cloud.value.toString()
  process.env.DEVNET_BOR_HOSTS = dnsIps

  dnsIps = setBorAndErigonHosts(dnsIps)
  process.env.INSTANCES_IDS = ids
  process.env.CLOUD = cloud

  await validateConfigs(cloud)

  shell.exec(
    `cp ../../configs/devnet/${devnetType}-setup-config.yaml ../../deployments/devnet-${devnetId}`
  )
  shell.exec(
    `cp ../../configs/devnet/openmetrics-conf.yaml ../../deployments/devnet-${devnetId}`
  )
  shell.exec(
    `cp ../../configs/devnet/otel-config-dd.yaml ../../deployments/devnet-${devnetId}`
  )

  if (devnetType === 'docker') {
    await editMaticCliDockerYAMLConfig()
  } else {
    await editMaticCliRemoteYAMLConfig()
  }

  console.log('📍Waiting 30s for the VMs to initialize...')
  await timer(30000)

  await installRequiredSoftwareOnRemoteMachines(dnsIps, devnetType, devnetId)

  await prepareMaticCLI(dnsIps, devnetType, devnetId)

  await eventuallyCleanupPreviousDevnet(dnsIps, devnetType, devnetId)

  if (devnetType === 'docker') {
    await runDockerSetupWithMaticCLI(dnsIps, devnetId)
  } else {
    await runRemoteSetupWithMaticCLI(dnsIps, devnetId)
  }
}
