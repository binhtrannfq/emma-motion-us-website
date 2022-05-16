import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as docker from "@pulumi/docker";

const appName = "emma-motion-hotsite-sleep-conference";

export = async () => {
  const ecr = new aws.ecr.Repository(`emmaint-prod.${appName}.ecr-rep`, {
    imageTagMutability: "IMMUTABLE",
    name: appName,
    tags: { "emma:environment": "shared" },
  });

  new aws.ecr.RepositoryPolicy(`emmaint-prod.${appName}.ecr-rep-pol`, {
    repository: ecr.name,
    policy: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: {
            // Only emmaint-prod call pull the image
            AWS: ["arn:aws:iam::022548702091:root"],
          },
          Action: [
            "ecr:BatchCheckLayerAvailability",
            "ecr:BatchGetImage",
            "ecr:DescribeImages",
            "ecr:DescribeRepositories",
            "ecr:GetDownloadUrlForLayer",
          ],
        },
      ],
    },
  });

  const registryInfo = ecr.registryId.apply(async (id) => {
    const credentials = await aws.ecr.getCredentials({ registryId: id });
    const decodedCredentials = Buffer.from(
      credentials.authorizationToken,
      "base64"
    ).toString();
    const [username, password] = decodedCredentials.split(":");
    if (!password || !username) {
      throw new Error("Invalid credentials");
    }
    return {
      server: credentials.proxyEndpoint,
      username: username,
      password: password,
    };
  });

  const imageName = pulumi.interpolate`${ecr.repositoryUrl}:${Date.now()}`;

  const image = new docker.Image(`emmaint-prod.${appName}.docker`, {
    build: `../`,
    skipPush: false,
    imageName: imageName,
    registry: registryInfo,
  });

  const eksName = await aws.ssm.getParameter({
    name: "eks-name",
  });

  const eks = await aws.eks.getCluster({
    name: eksName.value,
  });

  const k8sProvider = new k8s.Provider("K8SProvider", {
    kubeconfig: JSON.stringify({
      apiVersion: "v1",
      clusters: [
        {
          cluster: {
            server: eks.endpoint,
            "certificate-authority-data": eks.certificateAuthorities[0].data,
          },
          name: "kubernetes",
        },
      ],
      contexts: [
        {
          context: {
            cluster: "kubernetes",
            user: "aws",
          },
          name: "aws",
        },
      ],
      "current-context": "aws",
      kind: "Config",
      users: [
        {
          name: "aws",
          user: {
            exec: {
              apiVersion: "client.authentication.k8s.io/v1alpha1",
              command: "aws",
              args: ["eks", "get-token", "--cluster-name", eks.name],
            },
          },
        },
      ],
    }),
  });

  new k8s.apps.v1.Deployment(
    `emmaint-prod.${appName}.k8s-deployment`,
    {
      metadata: {
        name: appName,
        namespace: "default",
      },
      spec: {
        strategy: {
          rollingUpdate: {
            maxSurge: 0,
            maxUnavailable: 1,
          },
        },
        selector: {
          matchLabels: {
            app: appName,
          },
        },
        replicas: 2,
        template: {
          metadata: {
            name: appName,
            labels: {
              app: appName,
            },
          },
          spec: {
            containers: [
              {
                name: "app",
                image: imageName,
                ports: [
                  {
                    name: "http",
                    containerPort: 3000,
                  },
                ],
              },
            ],
          },
        },
      },
    },
    {
      provider: k8sProvider,
      dependsOn: [image],
    }
  );

  const service = new k8s.core.v1.Service(
    `emmaint-prod.${appName}.k8s-service`,
    {
      metadata: {
        name: appName,
        namespace: "default",
      },
      spec: {
        type: "ClusterIP",
        ports: [
          {
            name: "http",
            port: 80,
            targetPort: 3000,
            protocol: "TCP",
          },
        ],
        selector: {
          app: appName,
        },
      },
    },
    {
      provider: k8sProvider,
    }
  );

  new k8s.networking.v1.Ingress(
    `emmaint-prod.${appName}.k8s-ingress`,
    {
      metadata: {
        name: appName,
        namespace: "default",
        annotations: {
          "kubernetes.io/ingress.class": "nginx",
        },
      },
      spec: {
        rules: [
          {
            host: "bedding-conf.emma-sleep.com",
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: service.metadata.name,
                      port: {
                        name: "http",
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
    {
      provider: k8sProvider,
    }
  );
};
