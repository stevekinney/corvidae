<script lang="ts">
  import { Footer } from '@corvidae/cinder';
  const groups = [
    {
      id: 'product',
      title: 'Product',
      links: [
        { id: 'features', label: 'Features', href: '/features' },
        { id: 'pricing', label: 'Pricing', href: '/pricing' },
      ],
    },
    {
      id: 'company',
      title: 'Company',
      links: [
        { id: 'about', label: 'About', href: '/about' },
        { id: 'careers', label: 'Careers', href: '/careers' },
      ],
    },
  ];
  const legalLinks = [
    { id: 'privacy', label: 'Privacy', href: '/privacy' },
    { id: 'terms', label: 'Terms', href: '/terms' },
  ];
</script>

<div id="example-mount-basic">
  <Footer
    brand="Acme"
    description="Design tools for modern teams."
    {groups}
    copyright="© 2026 Acme"
    {legalLinks}
  />
</div>

<style>
  :global(html) {
    font-size: 16px;
  }
  :global(.cinder-footer) {
    box-sizing: content-box;
  }
</style>
