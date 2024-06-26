import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

interface GetScriptProps {
    publicKeys: Array<string>;
    proxyUserName: string;
    allowShell: boolean;
    allowEc2MetadataServiceAccess: boolean;
    serverKeyEd25519Secret?: secretsmanager.ISecret;
    serverKeyEcdsaSecret?: secretsmanager.ISecret;
}

const escapeShellString = (str: string): string => {
    return `'${str.replace(/'/g, "'\\''")}'`;
};

const getScript = (props: GetScriptProps): string => {
    const b64EncodedKeys = props.publicKeys.map((key) => Buffer.from(key).toString('base64'));
    const publickeysBase64Encoded = b64EncodedKeys.join(' ');
    return `#!/bin/bash

#!/bin/bash -ex

proxy_user_name=${escapeShellString(props.proxyUserName)}
allow_shell=${props.allowShell ? '1' : ''}
allow_ec2_metadata_service_access=${props.allowEc2MetadataServiceAccess ? '1' : ''}

stderr() {
    >&2 echo "$1"
}

error() {
    stderr "Error: $1"
    exit 1
}

publickeys_base64_encoded="${publickeysBase64Encoded}"

main() {
    sshRestartRequired=0
    serverKeyEd25519SecretArn="$SERVER_KEY_ED25519_SECRET_ARN"
    if [[ -n $serverKeyEd25519SecretArn ]]; then
        serverKeyEd25519=$(aws secretsmanager get-secret-value --secret-id "$serverKeyEd25519SecretArn" --query SecretString --output text)
        echo "Adding Ed25519 server key..."
        echo "$serverKeyEd25519" | sudo tee /etc/ssh/ssh_host_ed25519_key > /dev/null
        sudo ssh-keygen -f /etc/ssh/ssh_host_ed25519_key -y | sudo tee /etc/ssh/ssh_host_ed25519_key.pub > /dev/null
        echo "Added Ed25519 server key"
        sshRestartRequired=1
    fi

    serverKeyEcdsaSecretArn="$SERVER_KEY_ECDSA_SECRET_ARN"
    if [[ -n $serverKeyEcdsaSecretArn ]]; then
        serverKeyEcdsa=$(aws secretsmanager get-secret-value --secret-id "$serverKeyEcdsaSecretArn" --query SecretString --output text)
        echo "Adding ECDSA server key..."
        echo "$serverKeyEcdsa" | sudo tee /etc/ssh/ssh_host_ecdsa_key > /dev/null
        sudo ssh-keygen -f /etc/ssh/ssh_host_ecdsa_key -y | sudo tee /etc/ssh/ssh_host_ecdsa_key.pub > /dev/null
        echo "Added ECDSA server key"
        sshRestartRequired=1
    fi

    if [[ $sshRestartRequired -eq 1 ]]; then
        # Restart sshd to pick up the new keys
        sudo systemctl restart sshd
    fi

    if [[ -n $allow_ec2_metadata_service_access ]]; then
        echo "Disabling access to EC2 metadata service..."
        sudo yum install iptables-services -y
        sudo systemctl enable iptables
        sudo systemctl start iptables
        sudo iptables -A OUTPUT -m owner ! --uid-owner root -d 169.254.169.254 -j DROP
    fi

    sudo adduser "$proxy_user_name" ${props.allowShell ? '' : '--shell /sbin/nologin'}

    keysdecoded=0

    echo "Creating tmpdir..."
    tmpdir="$(mktemp -d -t dbpubkeys-XXXXXX)"
    echo "Created tmpdir at $tmpdir"

    echo "Decoding public keys..."
    for b64encodedkey in $publickeys_base64_encoded; do
        if [[ -n $b64encodedkey ]]; then
            echo "Decoding key $b64encodedkey..."
            keyfilename="$tmpdir/$keysdecoded.pub"
            echo "$b64encodedkey" | base64 -d > "$keyfilename"
            echo "Decoded key $b64encodedkey to $keyfilename"
            keysdecoded=$(($keysdecoded+1))
        fi
    done

    echo "Decoded $keysdecoded keys"

    ls -al "$tmpdir"

    # And print the contents of each file
    for filename in "$tmpdir"/*.pub; do
        if [[ -f $filename ]]; then
            echo "Key $filename:"
            cat "$filename"
            echo
        fi
    done

    proxyUserHome=/home/"$proxy_user_name"

    sudo mkdir -p "$proxyUserHome/.ssh"
    sudo chown -R "$proxy_user_name:$proxy_user_name" "$proxyUserHome"
    sudo chmod -R 700 "$proxyUserHome/.ssh"

    sudo chown -R "$proxy_user_name:$proxy_user_name" "$tmpdir"
    
    (sudo su - --shell=/bin/bash $proxy_user_name && {
         keysadded=0
         for filename in "$tmpdir"/*.pub; do
             if [[ -f $filename ]]; then
                 if ssh-keygen -l -f "$filename"; then
                     echo "Adding key $filename..."
                     {
                         cat "$filename"
                         echo
                     } >> "$proxyUserHome/.ssh/authorized_keys"
                     echo "Added key $filename"
                     keysadded=$(($keysadded+1))
                 else
                     stderr "Key $filename appears invalid, skipping"
                 fi
             fi
         done

         echo "Added $keysadded keys"
    })

    sudo rm -rf "$tmpdir"

    echo "Done"
}

main "$@"
`;
};

export interface Ec2HaBastionProps {
    /**
     * The VPC to deploy the bastion into
     */
    vpc: ec2.IVpc;
    /**
     * The instance type to use for the bastion
     * @default t3.nano
     */
    instanceType?: ec2.InstanceType;
    /**
     * The machine image to use for the bastion
     *
     * @default latest Amazon Linux 2023
     */
    machineImage?: ec2.IMachineImage;
    /**
     * The key name from EC2 to use for the EC2 instance default user (eg, ec2-user)
     */
    keyName?: string;
    /**
     * The CIDRs to allow SSH access from
     *
     * @default - No access from the internet
     */
    allowedCidrs?: string[];
    /**
     * Whether to allow SSH access from the internet
     *
     * @default false
     */
    openToInternet?: boolean;
    /**
     * The public keys to add to the bastion as strings. Must be given
     * in a format that ssh-keygen -l -f can understand, otherwise
     * the key will be ignored.
     *
     * @default - No public keys
     */
    publicKeys?: Array<string>;
    /**
     * The unix username for the proxy user. This must be different to the default user of the AMI.
     *
     * @default - proxyuser
     */
    proxyUserName?: string;

    /**
     * Whether to allow shell access to the proxy user. When enabled,
     * they will be able to run arbitrary commands on the
     * bastion. When disabled, they will be able to use SSH tunneling,
     * but not run arbitrary commands.
     *
     * @default false
     */
    allowShell?: boolean;
    /**
     * Whether to allow the proxy user to access the EC2 metadata service
     * at 192.168.192.168, allowing access to any IAM permissions granted
     * to the instance profile.
     *
     * Note that when serverKeys are set, this protection is set after the server keys
     * are retrieved, but before the proxyUserName user is created and
     * the provided publicKeys are added for that user.
     *
     * Beware that if this is set to true, and serverKeys are set,
     * proxy users would be able to retrieve the server keys from
     * secretsmanager.
     *
     * @default false
     */
    allowEc2MetadataServiceAccess?: boolean;

    /**
     * Options for setting host keys from SecretsManager secrets.
     *
     * Note that the key should be the whole body of the secret, and
     * in OpenSSH format, ie would be expected to start with
     * -----BEGIN OPENSSH PRIVATE KEY----- and end with
     * -----END OPENSSH PRIVATE KEY-----.
     */
    serverKeys?: {
        /**
         * Ed25519 private key that is stored at /etc/ssh/ssh_host_ed25519_key
         *
         * Key must be the whole body of the secret.
         */
        ed25519Secret?: secretsmanager.ISecret;
        /**
         * ECDSA private key that is stored at /etc/ssh/ssh_host_ecdsa_key
         *
         * Key must be the whole body of the secret.
         */
        ecdsaSecret?: secretsmanager.ISecret;
    };
}

export class Ec2HaBastion extends Construct implements ec2.IConnectable {
    public readonly connections: ec2.Connections;
    public readonly networkLoadBalancer: elbv2.INetworkLoadBalancer;

    constructor(scope: Construct, id: string, props: Ec2HaBastionProps) {
        super(scope, id);

        const userData = ec2.UserData.forLinux();
        if (props.publicKeys && props.publicKeys.length > 0) {
            const script = getScript({
                publicKeys: props.publicKeys,
                proxyUserName: props.proxyUserName ?? 'proxyuser',
                allowShell: props.allowShell ?? false,
                allowEc2MetadataServiceAccess: props.allowEc2MetadataServiceAccess ?? false,
            });
            const scriptBase64Encoded = Buffer.from(script).toString('base64');
            if (props.serverKeys?.ed25519Secret) {
                userData.addCommands(`export SERVER_KEY_ED25519_SECRET_ARN=${props.serverKeys.ed25519Secret.secretArn}`);
            }
            if (props.serverKeys?.ecdsaSecret) {
                userData.addCommands(`export SERVER_KEY_ECDSA_SECRET_ARN=${props.serverKeys.ecdsaSecret.secretArn}`);
            }

            userData.addCommands(`echo "${scriptBase64Encoded}" | base64 -d | bash`);
        } else {
            userData.addCommands('echo "No public keys to add"');
        }

        const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
            vpc: props.vpc,
            instanceType: props.instanceType ?? ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.NANO),
            machineImage: props.machineImage ?? ec2.MachineImage.latestAmazonLinux2023(),
            updatePolicy: autoscaling.UpdatePolicy.rollingUpdate(),
            keyName: props.keyName,
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
            },
            userData,
        });

        asg.role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));

        for (const serverKeySecret of Object.values(props.serverKeys ?? {})) {
            if (serverKeySecret) {
                serverKeySecret.grantRead(asg.role);
            }
        }

        this.connections = asg.connections;

        // Create an NLB in front of the ASG
        this.networkLoadBalancer = new elbv2.NetworkLoadBalancer(this, 'LB', {
            vpc: props.vpc,
            internetFacing: true,
            // Public subnets
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC,
            },
        });

        const listener = this.networkLoadBalancer.addListener('Listener', { port: 22 });

        listener.addTargets('Target', {
            port: 22,
            targets: [asg],
        });

        if (props.allowedCidrs && props.allowedCidrs.length > 0) {
            for (const cidr of props.allowedCidrs) {
                asg.connections.allowFrom(ec2.Peer.ipv4(cidr), ec2.Port.tcp(22));
            }
            // Also allow the NLB to connect to the ASG by allowing
            // access from the public subnets, this allows the NLB to
            // health check the instances.
            for (const subnet of props.vpc.publicSubnets) {
                const subnetPeer = ec2.Peer.ipv4(subnet.ipv4CidrBlock);
                asg.connections.allowFrom(subnetPeer, ec2.Port.tcp(22));
            }
        } else if (props.openToInternet) {
            asg.connections.allowFromAnyIpv4(ec2.Port.tcp(22));
        } else {
            throw new Error('Either allowedCidrs or openToInternet must be set');
        }
    }
}
