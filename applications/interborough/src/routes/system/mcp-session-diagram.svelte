<script lang="ts">
  /**
   * MCP request-protocol sequence diagram (plan §7.3 app-local net-new: "one
   * static themed SVG"; design `Weft UI.dc.html` "System" § DISCOVERY). Since
   * COR-1311 the endpoint keeps no session: initialize negotiates a protocol
   * version, and every later request carries its own credential. Static
   * and app-local by design — this documents the wire choreography every MCP
   * client goes through, not a data-driven render of anything the server
   * exposes.
   */
</script>

<svg
  viewBox="0 0 360 190"
  role="img"
  aria-label="MCP request protocol: client sends initialize, server answers with the negotiated protocol version, every later request carries its own credential, and a request without one gets a 401."
  class="weft-mcp-diagram"
>
  <text x="4" y="14" class="weft-mcp-diagram__lane-label">Client</text>
  <text x="356" y="14" text-anchor="end" class="weft-mcp-diagram__lane-label">Server</text>

  <!-- initialize -> -->
  <line
    x1="4"
    y1="42"
    x2="340"
    y2="42"
    class="weft-mcp-diagram__arrow-line weft-mcp-diagram__arrow-line--accent"
  />
  <polygon
    points="340,42 332,38 332,46"
    class="weft-mcp-diagram__arrowhead weft-mcp-diagram__arrowhead--accent"
  />
  <text x="4" y="34" class="weft-mcp-diagram__arrow-label weft-mcp-diagram__arrow-label--accent"
    >initialize →</text
  >

  <!-- <- protocol version -->
  <line
    x1="20"
    y1="80"
    x2="356"
    y2="80"
    class="weft-mcp-diagram__arrow-line weft-mcp-diagram__arrow-line--success"
  />
  <polygon
    points="20,80 28,76 28,84"
    class="weft-mcp-diagram__arrowhead weft-mcp-diagram__arrowhead--success"
  />
  <text
    x="356"
    y="72"
    text-anchor="end"
    class="weft-mcp-diagram__arrow-label weft-mcp-diagram__arrow-label--success"
    >← protocol version</text
  >

  <!-- request + credential -> -->
  <line
    x1="4"
    y1="118"
    x2="340"
    y2="118"
    class="weft-mcp-diagram__arrow-line weft-mcp-diagram__arrow-line--accent"
  />
  <polygon
    points="340,118 332,114 332,122"
    class="weft-mcp-diagram__arrowhead weft-mcp-diagram__arrowhead--accent"
  />
  <text x="4" y="110" class="weft-mcp-diagram__arrow-label weft-mcp-diagram__arrow-label--accent"
    >request + credential →</text
  >

  <!-- <- 401 without a credential -->
  <line
    x1="20"
    y1="156"
    x2="356"
    y2="156"
    class="weft-mcp-diagram__arrow-line weft-mcp-diagram__arrow-line--danger"
  />
  <polygon
    points="20,156 28,152 28,160"
    class="weft-mcp-diagram__arrowhead weft-mcp-diagram__arrowhead--danger"
  />
  <text
    x="356"
    y="148"
    text-anchor="end"
    class="weft-mcp-diagram__arrow-label weft-mcp-diagram__arrow-label--danger"
    >← 401 without a credential</text
  >

  <circle cx="4" cy="42" r="4" class="weft-mcp-diagram__dot weft-mcp-diagram__dot--accent" />
  <circle cx="356" cy="80" r="4" class="weft-mcp-diagram__dot weft-mcp-diagram__dot--success" />
  <circle cx="4" cy="118" r="4" class="weft-mcp-diagram__dot weft-mcp-diagram__dot--accent" />
  <circle cx="356" cy="156" r="4" class="weft-mcp-diagram__dot weft-mcp-diagram__dot--danger" />
</svg>

<style>
  .weft-mcp-diagram {
    width: 100%;
    height: auto;
    max-width: 420px;
  }

  .weft-mcp-diagram__lane-label {
    font-size: 9px;
    font-weight: 600;
    fill: var(--cinder-text-subtle);
  }

  .weft-mcp-diagram__arrow-line {
    stroke-width: 1;
  }

  .weft-mcp-diagram__arrow-line--accent {
    stroke: var(--cinder-accent-solid);
  }

  .weft-mcp-diagram__arrow-line--success {
    stroke: var(--cinder-status-success-solid);
  }

  .weft-mcp-diagram__arrow-line--danger {
    stroke: var(--cinder-status-danger-solid);
  }

  .weft-mcp-diagram__arrowhead--accent {
    fill: var(--cinder-accent-solid);
  }

  .weft-mcp-diagram__arrowhead--success {
    fill: var(--cinder-status-success-solid);
  }

  .weft-mcp-diagram__arrowhead--danger {
    fill: var(--cinder-status-danger-solid);
  }

  .weft-mcp-diagram__arrow-label {
    font-family: var(--cinder-font-mono);
    font-size: 9px;
  }

  .weft-mcp-diagram__arrow-label--accent {
    fill: var(--cinder-accent-text);
  }

  .weft-mcp-diagram__arrow-label--success {
    fill: var(--cinder-status-success-text);
  }

  .weft-mcp-diagram__arrow-label--danger {
    fill: var(--cinder-status-danger-text);
  }

  .weft-mcp-diagram__dot--accent {
    fill: var(--cinder-accent-solid);
  }

  .weft-mcp-diagram__dot--success {
    fill: var(--cinder-status-success-solid);
  }

  .weft-mcp-diagram__dot--danger {
    fill: var(--cinder-status-danger-solid);
  }
</style>
