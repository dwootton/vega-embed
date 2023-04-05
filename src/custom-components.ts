import '@wcd/dwootton.preact-lfa03675';
function validate(input: any) {
  console.log('input', input);
}
const template = document.createElement('template');
template.innerHTML = `
<div>
<span>hi there!</span>
<dual-slider min=0 max=100 onChange=validate></dual-slider>

</div>
`;
//console.log('rendering custom component', Slider);
class MinMaxSlider extends HTMLElement {
  constructor() {
    console.log('constructor!');
    super();
    const shadowRoot = this.attachShadow({mode: 'closed'});
    console.log('shadow rooting!');
    // let div = document. createElement ('div');
    // div.textContent = 'Big Bang Theory';
    // • shadowRoot.append(div);
    console.log('template', template, template.content, template.innerHTML);
    let clone = template.content.cloneNode(true);
    shadowRoot.append(clone);
  }
  connectedCallback() {}
}

const Elements = [{name: 'min-max-slider', class: MinMaxSlider}];

customElements.define('min-max-slider', MinMaxSlider);

export default Elements;
