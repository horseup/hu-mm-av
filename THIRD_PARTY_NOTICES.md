# Third-party notices

The hu-mm-av server binary is built from the Go modules below. Each keeps its own license. The release bundle
contains every license and NOTICE file in `third_party/`, collected with `go-licenses save`. The MPL-2.0 modules
are used unmodified; their source is available at the links below.

The webapp (`webapp/main.js`, `public/pcm-tap.js`) has no third-party code. At runtime it uses React, ReactDOM and
React-Redux, which the Mattermost web app provides.

| Module | License | License text |
| --- | --- | --- |
| `github.com/Masterminds/semver/v3` | MIT | [link](https://github.com/Masterminds/semver/blob/v3.5.0/LICENSE.txt) |
| `github.com/aws/aws-sdk-go-v2` | Apache-2.0 | [link](https://github.com/aws/aws-sdk-go-v2/blob/v1.48.0/LICENSE.txt) |
| `github.com/aws/aws-sdk-go-v2/internal/sync/singleflight` | BSD-3-Clause | [link](https://github.com/aws/aws-sdk-go-v2/blob/v1.48.0/internal/sync/singleflight/LICENSE) |
| `github.com/aws/smithy-go` | Apache-2.0 | [link](https://github.com/aws/smithy-go/blob/v1.28.9/LICENSE) |
| `github.com/aws/smithy-go/internal/sync/singleflight` | BSD-3-Clause | [link](https://github.com/aws/smithy-go/blob/v1.28.9/internal/sync/singleflight/LICENSE) |
| `github.com/beevik/etree` | BSD-2-Clause | [link](https://github.com/beevik/etree/blob/v1.8.1/LICENSE) |
| `github.com/dyatlov/go-opengraph/opengraph` | MIT | [link](https://github.com/dyatlov/go-opengraph/blob/606d7b1e5f8a/opengraph/LICENSE) |
| `github.com/fatih/color` | MIT | [link](https://github.com/fatih/color/blob/v1.19.0/LICENSE.md) |
| `github.com/francoispqt/gojay` | MIT | [link](https://github.com/francoispqt/gojay/blob/v1.2.13/LICENSE) |
| `github.com/go-asn1-ber/asn1-ber` | MIT | [link](https://github.com/go-asn1-ber/asn1-ber/blob/v1.5.8/LICENSE) |
| `github.com/goccy/go-yaml` | MIT | [link](https://github.com/goccy/go-yaml/blob/v1.19.2/LICENSE) |
| `github.com/golang/protobuf/ptypes/empty` | BSD-3-Clause | [link](https://github.com/golang/protobuf/blob/v1.5.4/LICENSE) |
| `github.com/google/uuid` | BSD-3-Clause | [link](https://github.com/google/uuid/blob/v1.6.0/LICENSE) |
| `github.com/gorilla/websocket` | BSD-2-Clause | [link](https://github.com/gorilla/websocket/blob/v1.5.3/LICENSE) |
| `github.com/hashicorp/errwrap` | MPL-2.0 | [link](https://github.com/hashicorp/errwrap/blob/v1.1.0/LICENSE) |
| `github.com/hashicorp/go-hclog` | MIT | [link](https://github.com/hashicorp/go-hclog/blob/v1.6.3/LICENSE) |
| `github.com/hashicorp/go-multierror` | MPL-2.0 | [link](https://github.com/hashicorp/go-multierror/blob/v1.1.1/LICENSE) |
| `github.com/hashicorp/go-plugin` | MPL-2.0 | [link](https://github.com/hashicorp/go-plugin/blob/v1.8.0/LICENSE) |
| `github.com/hashicorp/yamux` | MPL-2.0 | [link](https://github.com/hashicorp/yamux/blob/v0.1.2/LICENSE) |
| `github.com/jonboulle/clockwork` | Apache-2.0 | [link](https://github.com/jonboulle/clockwork/blob/v0.5.0/LICENSE) |
| `github.com/lib/pq` | MIT | [link](https://github.com/lib/pq/blob/v1.12.3/LICENSE) |
| `github.com/mattermost/go-i18n/i18n` | MIT | [link](https://github.com/mattermost/go-i18n/blob/5c415071e404/LICENSE) |
| `github.com/mattermost/gosaml2` | Apache-2.0 | [link](https://github.com/mattermost/gosaml2/blob/v0.10.0/LICENSE) |
| `github.com/mattermost/ldap` | MIT | [link](https://github.com/mattermost/ldap/blob/0f480c025956/LICENSE) |
| `github.com/mattermost/logr/v2` | MIT | [link](https://github.com/mattermost/logr/blob/v2.0.25/LICENSE) |
| `github.com/mattermost/mattermost/server/public` | Apache-2.0 | [link](https://github.com/mattermost/mattermost/blob/server/public/v0.6.1/server/public/LICENSE.txt) |
| `github.com/mattermost/xml-roundtrip-validator` | Apache-2.0 | [link](https://github.com/mattermost/xml-roundtrip-validator/blob/v0.1.0/LICENSE.txt) |
| `github.com/mattn/go-colorable` | MIT | [link](https://github.com/mattn/go-colorable/blob/v0.1.16/LICENSE) |
| `github.com/mattn/go-isatty` | MIT | [link](https://github.com/mattn/go-isatty/blob/v0.0.24/LICENSE) |
| `github.com/oklog/run` | Apache-2.0 | [link](https://github.com/oklog/run/blob/v1.2.0/LICENSE) |
| `github.com/pborman/uuid` | BSD-3-Clause | [link](https://github.com/pborman/uuid/blob/v1.2.1/LICENSE) |
| `github.com/pelletier/go-toml` | Apache-2.0 | [link](https://github.com/pelletier/go-toml/blob/v1.9.5/LICENSE) |
| `github.com/pelletier/go-toml` | MIT | [link](https://github.com/pelletier/go-toml/blob/v1.9.5/LICENSE) |
| `github.com/philhofer/fwd` | MIT | [link](https://github.com/philhofer/fwd/blob/v1.2.1/LICENSE.md) |
| `github.com/pkg/errors` | BSD-2-Clause | [link](https://github.com/pkg/errors/blob/v0.9.1/LICENSE) |
| `github.com/russellhaering/goxmldsig` | Apache-2.0 | [link](https://github.com/russellhaering/goxmldsig/blob/v1.6.1/LICENSE) |
| `github.com/stretchr/testify/assert` | MIT | [link](https://github.com/stretchr/testify/blob/v1.12.1/LICENSE) |
| `github.com/stretchr/testify/internal/difflib` | BSD-3-Clause | [link](https://github.com/stretchr/testify/blob/v1.12.1/internal/difflib/LICENSE) |
| `github.com/stretchr/testify/internal/spew` | ISC | [link](https://github.com/stretchr/testify/blob/v1.12.1/internal/spew/LICENSE) |
| `github.com/tinylib/msgp/msgp` | MIT | [link](https://github.com/tinylib/msgp/blob/v1.6.5/LICENSE) |
| `github.com/vmihailenco/msgpack/v5` | BSD-2-Clause | [link](https://github.com/vmihailenco/msgpack/blob/v5.4.1/LICENSE) |
| `github.com/vmihailenco/tagparser/v2` | BSD-2-Clause | [link](https://github.com/vmihailenco/tagparser/blob/v2.0.0/LICENSE) |
| `github.com/wiggin77/merror` | MIT | [link](https://github.com/wiggin77/merror/blob/v1.0.5/LICENSE) |
| `github.com/wiggin77/srslog` | BSD-3-Clause | [link](https://github.com/wiggin77/srslog/blob/v1.0.1/LICENSE) |
| `go.yaml.in/yaml/v3` | MIT | [link](https://github.com/yaml/go-yaml/blob/v3.0.6/LICENSE) |
| `golang.org/x/crypto` | BSD-3-Clause | [link](https://cs.opensource.google/go/x/crypto/+/v0.58.0:LICENSE) |
| `golang.org/x/mod/semver` | BSD-3-Clause | [link](https://cs.opensource.google/go/x/mod/+/v0.42.0:LICENSE) |
| `golang.org/x/net` | BSD-3-Clause | [link](https://cs.opensource.google/go/x/net/+/v0.62.0:LICENSE) |
| `golang.org/x/sys/unix` | BSD-3-Clause | [link](https://cs.opensource.google/go/x/sys/+/v0.49.0:LICENSE) |
| `golang.org/x/text` | BSD-3-Clause | [link](https://cs.opensource.google/go/x/text/+/v0.43.0:LICENSE) |
| `google.golang.org/genproto/googleapis/rpc/status` | Apache-2.0 | [link](https://github.com/googleapis/go-genproto/blob/2ffab32bce7e/googleapis/rpc/LICENSE) |
| `google.golang.org/grpc` | Apache-2.0 | [link](https://github.com/grpc/grpc-go/blob/v1.85.0/LICENSE) |
| `google.golang.org/protobuf` | BSD-3-Clause | [link](https://github.com/protocolbuffers/protobuf-go/blob/v1.36.12/LICENSE) |
| `gopkg.in/natefinch/lumberjack.v2` | MIT | [link](https://github.com/natefinch/lumberjack/blob/v2.2.1/LICENSE) |
| `gopkg.in/yaml.v2` | Apache-2.0 | [link](https://github.com/go-yaml/yaml/blob/v2.4.0/LICENSE) |
