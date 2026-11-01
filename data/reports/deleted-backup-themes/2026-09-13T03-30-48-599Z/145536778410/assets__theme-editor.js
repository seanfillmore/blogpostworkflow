function hideProductModal() {
  const productModal = document.querySelectorAll('product-modal[open]');
  productModal && productModal.forEach((modal) => modal.hide());
}

document.addEventListener('shopify:block:select', function (event) {
  hideProductModal();

  const blockSelectedIsSeasonalDeal = event.target.classList.contains('seasonal-deal__item');
  const blockSelectedIsShowcaseSlide = event.target.classList.contains('slider--showcase__slide');
  const blockSelectedIsRegularSlide = event.target.classList.contains('slideshow__slide');
  
  if (blockSelectedIsSeasonalDeal) {
    const parentSeasonalDealPopover = event.target.closest('#deal-drawer');
    document.body.classList.add('with-popover');
    parentSeasonalDealPopover.showPopover();
  }

  if(blockSelectedIsShowcaseSlide) {
    const parentSlider = event.target.closest('.slider--showcase');
    const slideElementIndex = Array.prototype.slice.call(parentSlider.children).findIndex(item => item.dataset.index === event.target.dataset.index);
    parentSlider.slideTo(slideElementIndex);
  }

  if(blockSelectedIsRegularSlide) {
    console.log('blockSelectedIsRegularSlide!');
    const parentSlider = event.target.closest('slideshow-component');
    const slideElementIndex = event.target.dataset.slideIndex;
    parentSlider.slideTo(slideElementIndex);
  }
});

document.addEventListener('shopify:block:deselect', function (event) {
  const blockDeselectedIsSeasonalDeal = event.target.classList.contains('seasonal-deal__item');
  
  if (blockDeselectedIsSeasonalDeal) {
    const parentSeasonalDealPopover = event.target.closest('#deal-drawer');
    document.body.classList.remove('with-popover');
    parentSeasonalDealPopover.hidePopover();
  }
});

document.addEventListener('shopify:section:load', (eventevent) => {
  hideProductModal();
});

document.addEventListener('shopify:section:unload', (event) => {
  document.querySelectorAll(`[data-section="${event.detail.sectionId}"]`).forEach((element) => {
    element.remove();
    document.body.classList.remove('overflow-hidden');
  });
});

document.addEventListener('shopify:section:reorder', (event) => {
  hideProductModal();
});

document.addEventListener('shopify:section:select', (event) => {
  hideProductModal();
});

document.addEventListener('shopify:section:deselect', (event) => {
  hideProductModal();
});

document.addEventListener('shopify:inspector:activate', (event) => {
  hideProductModal();
});

document.addEventListener('shopify:inspector:deactivate', (event) => {
  hideProductModal();
});
