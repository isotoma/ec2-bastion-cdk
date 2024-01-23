# ec2-bastion-cdk

Docs: https://isotoma.github.io/ec2-bastion-cdk/

NPM: https://www.npmjs.com/package/ec2-bastion-cdk

Source: https://github.com/isotoma/ec2-bastion-cdk

## Example

```typescript
import { Ec2HaBastion } from 'ec2-bastion-cdk';

// ...

const bastion = new Ec2HaBastion(this, 'Bastion', {
    vpc: myVpc,
    allowedCidrs: [
        '1.2.3.999',
    ],
    publicKeys: [
        'ssh-ed225519 Abcdef123Xyz me@host',
    ],
    allowShell: true,
});

new route53.ARecord(this, 'BastionRecord', {
    recordName: 'mybastion',
    zone: myZone,
    target: route53.RecordTarget,fromAlias(new route53Targets.LoadBalancerTarget(bastion.networkLoadBalancer)),
});
